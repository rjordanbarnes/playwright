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

import fs from 'fs/promises';
import path from 'path';
import { test, expect, extensionId, connectWithToken, readExtensionToken } from './extension-fixtures';

import type { BrowserContext, TestInfo } from 'playwright/test';

async function createFrameInjector(testInfo: TestInfo) {
  const injector = testInfo.outputPath('frame-injector');
  await fs.mkdir(injector);
  await fs.writeFile(path.join(injector, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Frame injector',
    version: '1.0',
    content_scripts: [{ matches: ['http://*/*'], js: ['content.js'], run_at: 'document_idle' }],
    web_accessible_resources: [{ resources: ['frame.html'], matches: ['<all_urls>'] }],
  }));
  await fs.writeFile(path.join(injector, 'content.js'), `
    if (location.pathname === '/hello-world') {
      const frame = document.createElement('iframe');
      frame.id = 'foreign-frame';
      frame.src = chrome.runtime.getURL('frame.html');
      document.documentElement.appendChild(frame);
    }
  `);
  await fs.writeFile(path.join(injector, 'frame.html'), '<!DOCTYPE html><title>Foreign frame</title>');
  return injector;
}

async function watchDetach(browserContext: BrowserContext) {
  const serviceWorker = browserContext.serviceWorkers().find(w => w.url().includes(extensionId))!;
  await serviceWorker.evaluate(() => {
    (globalThis as any).__detach = [];
    (globalThis as any).chrome.debugger.onDetach.addListener((source: any, reason: string) => {
      (globalThis as any).__detach.push({ source, reason });
    });
  });
  return () => serviceWorker.evaluate(() => (globalThis as any).__detach);
}

test('debugger detaches from the whole tab when a subframe navigates to an unknown scheme', {
  annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/42089' },
}, async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  const { client } = await connectWithToken(browserContext, startClient, browserWithExtension.userDataDir);

  server.setContent('/signin', `<title>SignIn</title><div>QR CODE HERE</div>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/signin' } });

  const getDetach = await watchDetach(browserContext);
  const page = browserContext.pages().find(p => p.url().endsWith('/signin'))!;
  await page.evaluate(() => {
    const iframe = document.createElement('iframe');
    iframe.src = 'customscheme://cc/';
    document.body.appendChild(iframe);
  }).catch(() => {});

  await expect.poll(async () => (await getDetach()).length, { timeout: 5000 }).toBeGreaterThan(0);
  const detach = await getDetach();
  expect(detach[0].reason).toBe('target_closed');
  expect(detach[0].source.frameId).toBeUndefined();

  expect(page.url()).toContain('/signin');
  expect(await page.title()).toBe('SignIn');
});

test('recovers and can screenshot after the debugger is detached', {
  annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/42089' },
}, async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  const { client } = await connectWithToken(browserContext, startClient, browserWithExtension.userDataDir);

  server.setContent('/signin', `<title>SignIn</title><div>QR CODE HERE</div>`, 'text/html');

  const getDetach = await watchDetach(browserContext);
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/signin' },
  })).toHaveResponse({ snapshot: expect.stringContaining('QR CODE HERE') });

  const page = browserContext.pages().find(p => p.url().endsWith('/signin'))!;
  await page.evaluate(() => {
    const iframe = document.createElement('iframe');
    iframe.src = 'customscheme://cc/';
    document.body.appendChild(iframe);
  }).catch(() => {});

  await expect.poll(async () => (await getDetach()).length, { timeout: 5000 }).toBeGreaterThan(0);
  expect((await getDetach())[0].reason).toBe('target_closed');

  expect(browserContext.pages().find(p => p.url().endsWith('/signin'))).toBeTruthy();

  await expect.poll(async () => {
    const list = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
    return (list as any).content?.[0]?.text ?? '';
  }, { timeout: 15000 }).toContain('/signin');

  const list = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  const index = /- (\d+):[^\n]*\/signin/.exec((list as any).content[0].text)?.[1];
  expect(index).toBeTruthy();
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: Number(index) } });

  expect(await client.callTool({ name: 'browser_snapshot', arguments: {} })).toHaveResponse({
    inlineSnapshot: expect.stringContaining('QR CODE HERE'),
  });
  expect(await client.callTool({ name: 'browser_take_screenshot', arguments: {} })).toHaveResponse({
    code: expect.stringContaining('page.screenshot'),
  });
});

for (const grouped of [true, false]) {
  test(`recovers after another extension frame detaches the debugger (${grouped ? 'grouped' : 'ungrouped'})`, {
    annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/43517' },
  }, async ({ browserWithExtension, startClient, server }, testInfo) => {
    const injector = await createFrameInjector(testInfo);
    const browserContext = await browserWithExtension.launch(undefined, [injector]);
    const token = await readExtensionToken(browserContext);
    const statusPage = await browserContext.newPage();
    await statusPage.goto(`chrome-extension://${extensionId}/status.html`);
    const { client } = await startClient({
      args: ['--extension', ...(grouped ? [] : ['--no-tab-group'])],
      env: {
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
        PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
      },
    });

    const getDetach = await watchDetach(browserContext);
    const response = await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
    expect(response).toHaveResponse({
      isError: true,
      error: expect.stringContaining('frame that extensions are not allowed to debug'),
    });
    expect(JSON.stringify(response)).not.toContain('TypeError');
    await expect.poll(getDetach).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'target_closed' }),
    ]));
    const page = browserContext.pages().find(p => p.url() === server.HELLO_WORLD)!;
    const state = () => statusPage.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const { connections } = await chrome.runtime.sendMessage({ type: 'getConnectionStatus' });
      const tab = await chrome.tabs.get(connections[0]?.connectedTabIds[0]);
      return { connections, tabId: tab.id, groupId: tab.groupId };
    });
    await expect.poll(async () => (await state()).connections[0]?.connectedTabIds).toHaveLength(1);
    if (grouped)
      await expect.poll(async () => (await state()).groupId).toBeGreaterThan(-1);
    const before = await state();
    const pageCount = browserContext.pages().length;

    await expect(page.locator('#foreign-frame')).toBeAttached();
    // Outlast the old reconnect deadline without losing the approved tab.
    const detachedAt = Date.now();
    await expect.poll(async () => {
      expect(await state()).toEqual(before);
      return Date.now() - detachedAt;
    }, { timeout: 8000 }).toBeGreaterThan(3500);
    expect(await client.callTool({ name: 'browser_snapshot', arguments: {} })).toHaveResponse({
      isError: true,
      error: expect.stringContaining('No controlled tab is currently available'),
    });
    expect(browserContext.pages()).toHaveLength(pageCount);

    await page.locator('#foreign-frame').evaluate(element => element.remove());
    await expect.poll(async () => {
      const response = await client.callTool({ name: 'browser_snapshot', arguments: {} }) as any;
      return response.content[0].text;
    }, { timeout: 15000 }).toContain('Hello, world!');
    expect(await state()).toEqual(before);
    expect(browserContext.pages()).toHaveLength(pageCount);

    await page.reload();
    await expect(page.locator('#foreign-frame')).toBeAttached();
    await expect.poll(async () => {
      const response = await client.callTool({ name: 'browser_snapshot', arguments: {} }) as any;
      return response.isError;
    }).toBe(true);
    server.setContent('/recovered', '<body>Recovered</body>', 'text/html');
    await page.goto(server.PREFIX + '/recovered');
    await expect.poll(async () => {
      const response = await client.callTool({ name: 'browser_snapshot', arguments: {} }) as any;
      return response.content[0].text;
    }).toContain('Recovered');
    expect(await state()).toEqual(before);

    await page.goto(server.HELLO_WORLD);
    await expect.poll(async () => {
      const response = await client.callTool({ name: 'browser_snapshot', arguments: {} }) as any;
      return response.isError;
    }).toBe(true);
    if (grouped)
      await statusPage.evaluate(tabId => (globalThis as any).chrome.tabs.ungroup([tabId]), before.tabId);
    else
      await client.close();
    await page.goto(server.PREFIX + '/recovered');
    const releasedAt = Date.now();
    await expect.poll(async () => {
      const { connections } = await statusPage.evaluate(() =>
        (globalThis as any).chrome.runtime.sendMessage({ type: 'getConnectionStatus' }));
      expect(connections).toEqual([]);
      return Date.now() - releasedAt;
    }, { timeout: 8000 }).toBeGreaterThan(3500);
  });
}

test('stopping debugging revokes access instead of recovering on navigation', {
  annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/43517' },
}, async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  const statusPage = await browserContext.newPage();
  await statusPage.goto(`chrome-extension://${extensionId}/status.html`);
  const [sw] = browserContext.serviceWorkers();
  await sw.evaluate(() => {
    const chrome = (globalThis as any).chrome;
    const addListener = chrome.debugger.onDetach.addListener.bind(chrome.debugger.onDetach);
    (globalThis as any).__detachListeners = [];
    chrome.debugger.onDetach.addListener = (listener: any) => {
      (globalThis as any).__detachListeners.push(listener);
      addListener(listener);
    };
  });
  const { client } = await connectWithToken(browserContext, startClient, browserWithExtension.userDataDir);
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  const page = browserContext.pages().find(p => p.url() === server.HELLO_WORLD)!;
  await sw.evaluate(async () => {
    const chrome = (globalThis as any).chrome;
    const [tab] = await chrome.tabs.query({ title: 'Title' });
    await chrome.debugger.detach({ tabId: tab.id });
    for (const listener of (globalThis as any).__detachListeners)
      listener({ tabId: tab.id }, 'canceled_by_user');
  });
  await page.goto(server.EMPTY_PAGE);
  await expect.poll(() => statusPage.evaluate(async () => {
    const { connections } = await (globalThis as any).chrome.runtime.sendMessage({ type: 'getConnectionStatus' });
    return connections;
  })).toEqual([]);
});
