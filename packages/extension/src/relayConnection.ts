/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export function debugLog(...args: unknown[]): void {
  const enabled = true;
  if (enabled) {
    // eslint-disable-next-line no-console
    console.log('[Extension]', ...args);
  }
}

type ProtocolCommand = {
  id: number;
  method: string;
  params?: any;
};

type ProtocolResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

// Allow-listed chrome.* commands the relay may invoke. They are resolved
// reflectively and the positional params are spread into the call.
const ALLOWED_CHROME_COMMANDS = new Set([
  'chrome.debugger.attach',
  'chrome.debugger.detach',
  'chrome.debugger.sendCommand',
  'chrome.tabs.create',
  'chrome.tabs.remove',
]);

// chrome.* events the extension forwards to the relay (positional params).
const CHROME_EVENT_METHODS = [
  'chrome.debugger.onEvent',
  'chrome.debugger.onDetach',
  'chrome.tabs.onCreated',
  'chrome.tabs.onRemoved',
];

const REATTACH_DELAY_MS = 150;
const REATTACH_VERIFY_MS = 2500;
const REATTACH_COOLDOWN_MS = 3000;

export class RelayConnection {
  private _ws: WebSocket;
  // Approval belongs to the connection, not to a temporary debugger attachment.
  private _ownedTabs = new Set<number>();
  // Tabs whose debugger we have explicitly attached for this connection.
  private _attachedTabs = new Set<number>();
  // Invalidated when an in-flight attachment loses its approval or debugger.
  private _attachingTabs = new Map<number, object>();
  private _eventListeners: Array<{ remove: () => void }> = [];
  private _closed = false;
  private _pendingReattach = new Map<number, ReturnType<typeof setTimeout>>();
  private _recentReattach = new Set<number>();

  onclose?: () => void;
  ontabattached?: (tabId: number) => void;
  ontabdetached?: (tabId: number) => void;

  get attachedTabs(): ReadonlySet<number> {
    return this._attachedTabs;
  }

  get ownedTabs(): ReadonlySet<number> {
    return this._ownedTabs;
  }

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._installEventForwarders();
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
  }

  // Signals the end of the initial-tab handshake — call after the initial
  // round of `attachTab` invocations. The relay holds CDP traffic from
  // Playwright until it sees this event, so that `Target.setAutoAttach` is
  // answered from a populated tab model.
  didInitialize(): void {
    this._sendMessage({ method: 'extension.initialized', params: [] });
  }

  close(message: string): void {
    this._ws.close(1000, message);
    // ws.onclose is called asynchronously, so we call it here to avoid forwarding
    // CDP events to the closed connection.
    this._onClose();
  }

  // Called when the UI adds a tab to the Playwright group, whether as the
  // initial pick from the connect page or from a later drag-in. Simulates a
  // "new tab opened" event; the relay responds by calling
  // chrome.debugger.attach, which flows through _handleCommand and fires
  // ontabattached.
  attachTab(tab: chrome.tabs.Tab): void {
    if (this._closed || this._attachedTabs.has(tab.id!) || this._attachingTabs.has(tab.id!))
      return;
    this.retainTab(tab.id!);
    this._attachingTabs.set(tab.id!, {});
    this._sendMessage({ method: 'chrome.tabs.onCreated', params: [tab] });
  }

  retainTab(tabId: number): void {
    if (!this._closed)
      this._ownedTabs.add(tabId);
  }

  // Release approval even if the debugger is already unavailable. The synthetic
  // removal also prevents the relay from attaching the tab again.
  detachTab(tabId: number): void {
    if (this._closed || !this._ownedTabs.delete(tabId))
      return;
    this._cancelReattach(tabId);
    this._attachingTabs.delete(tabId);
    if (this._attachedTabs.has(tabId))
      detachDebugger(tabId);
    this._notifyTabDetached(tabId);
    this._sendMessage({ method: 'chrome.tabs.onRemoved', params: [tabId] });
    this._checkLastTabReleased();
  }

  private _notifyTabAttached(tabId: number): void {
    this._attachedTabs.add(tabId);
    this._cancelReattach(tabId);
    this.ontabattached?.(tabId);
  }

  private _notifyTabDetached(tabId: number): void {
    this._attachedTabs.delete(tabId);
    this.ontabdetached?.(tabId);
  }

  private _installEventForwarders(): void {
    for (const fullMethod of CHROME_EVENT_METHODS) {
      const target = resolveChromeMember(fullMethod);
      const listener = (...args: any[]) => this._onChromeEvent(fullMethod, args);
      target.obj[target.name].addListener(listener);
      this._eventListeners.push({
        remove: () => target.obj[target.name].removeListener(listener),
      });
    }
  }

  private _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    this._ownedTabs.clear();
    this._attachingTabs.clear();
    for (const timer of this._pendingReattach.values())
      clearTimeout(timer);
    this._pendingReattach.clear();
    this._recentReattach.clear();
    for (const l of this._eventListeners)
      l.remove();
    this._eventListeners = [];
    for (const tabId of [...this._attachedTabs]) {
      detachDebugger(tabId);
      this._notifyTabDetached(tabId);
    }
    this.onclose?.();
  }

  private _checkLastTabReleased(): void {
    if (this._ownedTabs.size === 0)
      this.close('All controlled tabs released');
  }

  // Forwards chrome.* events concerning approved tabs to the relay, then runs
  // shared detach bookkeeping.
  private _onChromeEvent(fullMethod: string, args: any[]): void {
    const tabId = this._tabIdForEventArgs(fullMethod, args);
    if (tabId === undefined || !this._ownedTabs.has(tabId))
      return;
    if (fullMethod === 'chrome.tabs.onCreated') {
      if (!this._attachedTabs.has(tabId))
        return;
      const tab = args[0] as chrome.tabs.Tab;
      if (tab.id !== undefined)
        this.retainTab(tab.id);
    } else if (fullMethod === 'chrome.tabs.onRemoved') {
      this._ownedTabs.delete(tabId);
      this._attachingTabs.delete(tabId);
      this._cancelReattach(tabId);
      this._sendMessage({ method: fullMethod, params: args });
      this._notifyTabDetached(tabId);
      this._checkLastTabReleased();
      return;
    } else if (fullMethod !== 'chrome.debugger.onDetach' && !this._attachedTabs.has(tabId)) {
      return;
    }
    this._sendMessage({ method: fullMethod, params: args });
    // chrome.debugger.onDetach is the single source of truth for detach bookkeeping.
    if (fullMethod === 'chrome.debugger.onDetach') {
      const reason = args[1] as string | undefined;
      this._attachingTabs.delete(tabId);
      if (reason !== 'target_closed') {
        this._ownedTabs.delete(tabId);
        this._cancelReattach(tabId);
        this._sendMessage({ method: 'chrome.tabs.onRemoved', params: [tabId] });
      }
      this._notifyTabDetached(tabId);
      if (reason === 'target_closed' && this._maybeScheduleReattach(tabId))
        return;
      this._checkLastTabReleased();
    }
  }

  private _maybeScheduleReattach(tabId: number): boolean {
    if (this._closed || !this._ownedTabs.has(tabId))
      return false;
    if (this._pendingReattach.has(tabId))
      return true;
    const delay = this._recentReattach.has(tabId) ? REATTACH_COOLDOWN_MS : REATTACH_DELAY_MS;
    this._recentReattach.add(tabId);
    setTimeout(() => this._recentReattach.delete(tabId), REATTACH_COOLDOWN_MS);
    this._pendingReattach.set(tabId, setTimeout(() => void this._tryReattach(tabId), delay));
    return true;
  }

  private _cancelReattach(tabId: number): void {
    clearTimeout(this._pendingReattach.get(tabId));
    this._pendingReattach.delete(tabId);
  }

  private _reattachAborted(tabId: number): boolean {
    return this._closed || !this._ownedTabs.has(tabId) || !this._pendingReattach.has(tabId);
  }

  private async _tryReattach(tabId: number): Promise<void> {
    if (this._reattachAborted(tabId))
      return;
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      this.detachTab(tabId);
      return;
    }
    if (this._reattachAborted(tabId))
      return;
    if (this._attachedTabs.has(tabId)) {
      this._cancelReattach(tabId);
      return;
    }
    this.attachTab(tab);
    this._pendingReattach.set(tabId, setTimeout(() => {
      if (this._reattachAborted(tabId))
        return;
      this._pendingReattach.delete(tabId);
      if (!this._attachedTabs.has(tabId))
        this._maybeScheduleReattach(tabId);
    }, REATTACH_VERIFY_MS));
  }

  // Returns the tabId an event refers to, for filtering by _ownedTabs.
  private _tabIdForEventArgs(fullMethod: string, args: any[]): number | undefined {
    switch (fullMethod) {
      case 'chrome.debugger.onEvent':
      case 'chrome.debugger.onDetach':
        return (args[0] as chrome.debugger.Debuggee | undefined)?.tabId;
      case 'chrome.tabs.onCreated': {
        const tab = args[0] as chrome.tabs.Tab;
        // Forward only popups opened by an attached tab; report the opener so cdpRelay
        // can filter / decide. We use the openerTabId for the attached-tab check.
        return tab.openerTabId;
      }
      case 'chrome.tabs.onRemoved':
        return args[0] as number;
    }
    return undefined;
  }

  private _onMessage(event: MessageEvent): void {
    this._onMessageAsync(event).catch(e => debugLog('Error handling message:', e));
  }

  private async _onMessageAsync(event: MessageEvent): Promise<void> {
    let message: ProtocolCommand;
    try {
      message = JSON.parse(event.data);
    } catch (error: any) {
      debugLog(`Error parsing message ${event.data}:`, error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }

    const response: ProtocolResponse = {
      id: message.id,
    };
    try {
      response.result = await this._handleCommand(message);
    } catch (error: any) {
      debugLog(`Error handling command ${JSON.stringify(message)}:`, error);
      response.error = error.message;
    }
    this._sendMessage(response);
  }

  private async _handleCommand(message: ProtocolCommand): Promise<any> {
    if (!ALLOWED_CHROME_COMMANDS.has(message.method))
      throw new Error(`Unknown method: ${message.method}`);
    const args = (message.params ?? []) as any[];
    if (message.method === 'chrome.debugger.attach') {
      const target = args[0] as chrome.debugger.Debuggee | undefined;
      const tabId = target?.tabId;
      if (this._closed || tabId === undefined || !this._ownedTabs.has(tabId))
        throw new Error('This tab is no longer shared with this client');
      const attempt = this._attachingTabs.get(tabId) ?? {};
      this._attachingTabs.set(tabId, attempt);
      try {
        const result = await invokeChromeMethod(message.method, args);
        if (this._closed || !this._ownedTabs.has(tabId) || this._attachingTabs.get(tabId) !== attempt) {
          detachDebugger(tabId);
          throw new Error('The debugger attachment was canceled');
        }
        this._notifyTabAttached(tabId);
        return result ?? {};
      } catch (error) {
        this._maybeScheduleReattach(tabId);
        throw error;
      } finally {
        if (this._attachingTabs.get(tabId) === attempt)
          this._attachingTabs.delete(tabId);
      }
    }
    if (message.method === 'chrome.debugger.sendCommand' && !this._attachedTabs.has(args[0]?.tabId))
      throw new Error('This tab is not attached to this client');
    if (message.method === 'chrome.tabs.remove') {
      const tabIds = Array.isArray(args[0]) ? args[0] : [args[0]];
      if (tabIds.some((tabId: number) => !this._ownedTabs.has(tabId)))
        throw new Error('This tab is no longer shared with this client');
    }
    const result = await invokeChromeMethod(message.method, args);
    if (message.method === 'chrome.tabs.create' && result?.id !== undefined)
      this.retainTab(result.id);
    return result ?? {};
  }

  private _sendError(code: number, message: string): void {
    this._sendMessage({
      error: {
        code,
        message,
      },
    });
  }

  private _sendMessage(message: any): void {
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(message));
  }
}

// ─── Reflective chrome.* invocation ────────────────────────────────────────

// Resolves chrome.<api>.<member>, shared by command invocation and event
// listener installation.
function resolveChromeMember(fullMethod: string): { obj: any; name: string } {
  const parts = fullMethod.split('.');
  if (parts[0] !== 'chrome' || parts.length < 3)
    throw new Error(`Invalid chrome method: ${fullMethod}`);
  let obj: any = chrome;
  for (let i = 1; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
    if (obj === undefined)
      throw new Error(`Unknown chrome path: ${parts.slice(0, i + 1).join('.')}, calling ${fullMethod}`);
  }
  return { obj, name: parts[parts.length - 1] };
}

function detachDebugger(tabId: number): void {
  chrome.debugger.detach({ tabId }).catch(error => {
    debugLog('Error detaching tab:', error);
  });
}

async function invokeChromeMethod(fullMethod: string, args: any[]): Promise<any> {
  const { obj, name } = resolveChromeMember(fullMethod);
  const fn = obj[name] as (...a: any[]) => any;
  if (typeof fn !== 'function')
    throw new Error(`Not a function: ${fullMethod}`);
  return await fn.apply(obj, args);
}
