#!/usr/bin/env node

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const PROTOCOL_VERSION = 2;
const BRIDGE_VERSION = 1;
const POLL_INTERVAL_MS = 1_000;
const COMMAND_FILE_POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const FRAME_INTERVAL_MS = 500;
const CONTROLLER_LEASE_MS = 120_000;
const LEASE_CHECK_INTERVAL_MS = 5_000;

let browser;
let context;
let page;
let stopped = false;
let generation = 0;
let commandQueue = Promise.resolve();
let lastSemantic = '';
let lastVersion = -1;
let lastHeartbeatAt = Date.now();
let lastAttention = '';
let readyGeneration = -1;
let input;
let commandFileTimer;
let leaseTimer;
let commandFileOffset = 0;
let pendingCommandBytes = Buffer.alloc(0);
let lastControllerActivity = Date.now();
let controllerSuspended = false;
let changedInputRawMode = false;

function emit(message) {
  process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, ...message })}\n`);
}

function commandError(command, message) {
  emit({ type: 'ack', command, ok: false, error: message });
}

function disablePtyEcho() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function' || process.stdin.isRaw) return;
  try {
    process.stdin.setRawMode(true);
    changedInputRawMode = true;
  } catch {
    // 某些伪终端不允许调整模式；不影响 JSONL 输入，只会保留终端自身的回显。
  }
}

function restorePtyMode() {
  if (!changedInputRawMode || typeof process.stdin.setRawMode !== 'function') return;
  try {
    process.stdin.setRawMode(false);
  } catch {
    // PTY 可能已经由宿主关闭。
  }
  changedInputRawMode = false;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key !== '--url' && key !== '--name' && key !== '--commands-file') throw new Error(`未知参数：${key}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`参数 ${key} 缩少值`);
    args[key === '--commands-file' ? 'commandsFile' : key.slice(2)] = value;
    index += 1;
  }
  if (!args.url) throw new Error('缺少 --url <agent-url>');
  if (!args.name) throw new Error('缺少 --name <player-name>');
  return args;
}

function parseReadEventsArgs(argv) {
  if (argv[0] !== '--read-events') return null;
  const eventsFile = argv[1];
  if (!eventsFile) throw new Error('--read-events 缺少事件日志路径');
  if (argv[2] !== '--cursor-file' || !argv[3] || argv.length !== 4) {
    throw new Error('读取事件需要 --read-events <events.jsonl> --cursor-file <cursor-file>');
  }
  return { eventsFile, cursorFile: argv[3] };
}

async function readCursor(cursorFile) {
  try {
    const value = Number.parseInt(await fs.promises.readFile(cursorFile, 'utf8'), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function writeCursor(cursorFile, offset) {
  const temporary = `${cursorFile}.tmp-${process.pid}`;
  await fs.promises.writeFile(temporary, `${offset}\n`, 'utf8');
  await fs.promises.rename(temporary, cursorFile);
}

async function readIncrementalEvents(eventsFile, cursorFile) {
  const stat = await fs.promises.stat(eventsFile);
  let offset = await readCursor(cursorFile);
  if (offset > stat.size) offset = 0;
  if (offset === stat.size) return { bytes: Buffer.alloc(0), nextOffset: offset };

  const length = stat.size - offset;
  const bytes = Buffer.alloc(length);
  const handle = await fs.promises.open(eventsFile, 'r');
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(bytes, 0, length, offset));
  } finally {
    await handle.close();
  }

  const available = bytes.subarray(0, bytesRead);
  const lastNewline = available.lastIndexOf(0x0a);
  if (lastNewline < 0) return { bytes: Buffer.alloc(0), nextOffset: offset };
  const completeLines = available.subarray(0, lastNewline + 1);
  return { bytes: completeLines, nextOffset: offset + completeLines.length };
}

function buildPlayerUrl(rawUrl, name) {
  const url = new URL(rawUrl);
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const question = hash.indexOf('?');
  const route = question >= 0 ? hash.slice(0, question) : hash;
  const params = new URLSearchParams(question >= 0 ? hash.slice(question + 1) : '');
  params.set('name', name);
  url.hash = `${route}?${params.toString()}`;
  return url.href;
}

function classifySnapshot(snapshot, previousSemantic, firstSnapshot) {
  const semantic = JSON.stringify({
    description: snapshot.description,
    state: snapshot.state,
  });
  const viewChanged = firstSnapshot || semantic !== previousSemantic;
  const hasEvents = (snapshot.events?.length ?? 0) > 0;
  return { semantic, viewChanged, hasEvents };
}

function controllerLeaseExpired(lastActivity, now = Date.now()) {
  return now - lastActivity >= CONTROLLER_LEASE_MS;
}

function loadChromium() {
  const cwdEntry = pathToFileURL(path.join(process.cwd(), '__parti_agent_runner__.cjs'));
  const requireFromCwd = createRequire(cwdEntry);
  const playwright = requireFromCwd('playwright');
  if (!playwright?.chromium) throw new Error('当前 playwright 安装未提供 chromium');
  return playwright.chromium;
}

async function closeBrowser() {
  generation += 1;
  const oldPage = page;
  const oldContext = context;
  const oldBrowser = browser;
  page = undefined;
  context = undefined;
  browser = undefined;
  await Promise.allSettled([
    oldPage?.close(),
    oldContext?.close(),
    oldBrowser?.close(),
  ]);
}

function emitAttention(status, error, recoverable = true) {
  const key = JSON.stringify([status, error, recoverable]);
  if (key === lastAttention) return;
  lastAttention = key;
  emit({
    type: 'attention',
    status,
    error,
    recoverable,
    commands: recoverable ? ['retry', 'stop'] : ['stop'],
  });
}

async function readSnapshot(targetPage, includeState = false) {
  return targetPage.evaluate(({ expectedBridgeVersion, includeFullState }) => {
    const bridge = window.__partiAgent;
    if (!bridge) return { status: 'connecting', error: 'window.__partiAgent 尚未就绪' };
    const status = bridge.status();
    const result = {
      bridgeVersion: bridge.version,
      status,
      error: bridge.error(),
      playerId: bridge.playerId(),
      stateVersion: bridge.stateVersion,
      events: status === 'connected' ? bridge.drainEvents() : [],
    };
    if (bridge.version !== expectedBridgeVersion || status !== 'connected') return result;
    const description = bridge.describe();
    if (description === null || includeFullState) result.state = bridge.getState();
    if (description !== null) result.description = description;
    return result;
  }, { expectedBridgeVersion: BRIDGE_VERSION, includeFullState: includeState });
}

function createUpdateMessage(snapshot, reason, includeView = true) {
  return {
    type: 'update',
    reason,
    status: snapshot.status,
    playerId: snapshot.playerId ?? null,
    stateVersion: snapshot.stateVersion ?? null,
    source: includeView ? (snapshot.description === undefined ? 'state' : 'description') : 'events',
    ...(includeView && snapshot.description !== undefined ? { description: snapshot.description } : {}),
    ...(includeView && snapshot.state !== undefined ? { state: snapshot.state } : {}),
    events: snapshot.events ?? [],
  };
}

function emitUpdate(snapshot, reason, includeView = true) {
  emit(createUpdateMessage(snapshot, reason, includeView));
}

async function observe(targetGeneration) {
  if (stopped || targetGeneration !== generation || !page) return;
  try {
    const snapshot = await readSnapshot(page);
    if (targetGeneration !== generation || stopped) return;

    if (snapshot.bridgeVersion !== undefined && snapshot.bridgeVersion !== BRIDGE_VERSION) {
      emitAttention(
        snapshot.status,
        `不支持的 __partiAgent bridge 版本：${snapshot.bridgeVersion}，需要 ${BRIDGE_VERSION}`,
        false,
      );
    } else if (snapshot.status === 'connected') {
      lastAttention = '';
      if (readyGeneration !== targetGeneration) {
        await page.evaluate(() => window.__partiAgent.ready());
        readyGeneration = targetGeneration;
      }

      const classification = classifySnapshot(snapshot, lastSemantic, lastVersion < 0);
      if (classification.viewChanged) {
        emitUpdate(snapshot, lastVersion < 0 ? 'connected' : 'changed');
        lastHeartbeatAt = Date.now();
      } else if (classification.hasEvents) {
        emitUpdate(snapshot, 'events', false);
        lastHeartbeatAt = Date.now();
      }
      lastSemantic = classification.semantic;
      lastVersion = snapshot.stateVersion ?? lastVersion;
    } else if (snapshot.status === 'error' || snapshot.status === 'closed') {
      emitAttention(snapshot.status, snapshot.error ?? `房间状态为 ${snapshot.status}`);
    }

    if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      emit({
        type: 'heartbeat',
        status: snapshot.status,
        stateVersion: snapshot.stateVersion ?? null,
      });
      lastHeartbeatAt = Date.now();
    }
  } catch (error) {
    emitAttention('runner-error', error instanceof Error ? error.message : String(error));
  }

  if (!stopped && targetGeneration === generation) {
    setTimeout(() => void observe(targetGeneration), POLL_INTERVAL_MS);
  }
}

async function openBrowser(agentUrl, playerName) {
  await closeBrowser();
  const targetGeneration = generation;
  lastSemantic = '';
  lastVersion = -1;
  lastHeartbeatAt = Date.now();
  lastAttention = '';
  readyGeneration = -1;

  try {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
    if (!Number.isFinite(major) || major < 20) {
      throw new Error(`需要 Node 20+，当前为 ${process.versions.node}`);
    }
    const chromium = loadChromium();
    const launchedBrowser = await chromium.launch({ headless: true });
    if (targetGeneration !== generation || stopped) {
      await launchedBrowser.close();
      return;
    }
    browser = launchedBrowser;
    const launchedContext = await browser.newContext({
      viewport: { width: 640, height: 480 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    if (targetGeneration !== generation || stopped) {
      await launchedContext.close();
      return;
    }
    context = launchedContext;
    await context.addInitScript(({ frameInterval }) => {
      const timers = new Map();
      let nextFrameId = 1;
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value(callback) {
          const frameId = nextFrameId++;
          const timer = setTimeout(() => {
            timers.delete(frameId);
            callback(performance.now());
          }, frameInterval);
          timers.set(frameId, timer);
          return frameId;
        },
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        writable: true,
        value(frameId) {
          const timer = timers.get(frameId);
          if (timer !== undefined) clearTimeout(timer);
          timers.delete(frameId);
        },
      });
    }, { frameInterval: FRAME_INTERVAL_MS });
    const launchedPage = await context.newPage();
    if (targetGeneration !== generation || stopped) {
      await launchedPage.close();
      return;
    }
    page = launchedPage;
    const playerUrl = buildPlayerUrl(agentUrl, playerName);
    await page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: CONNECT_TIMEOUT_MS });
    await page.waitForFunction(
      (expectedVersion) => window.__partiAgent?.version === expectedVersion,
      BRIDGE_VERSION,
      { timeout: CONNECT_TIMEOUT_MS },
    );
    if (targetGeneration !== generation || stopped) return;
    controllerSuspended = false;
    void observe(targetGeneration);
  } catch (error) {
    await closeBrowser();
    emitAttention(
      'startup-error',
      `${error instanceof Error ? error.message : String(error)}。请确认 Node 20+、当前目录已安装 playwright/Chromium，且房间网络可达。`,
    );
  }
}

function touchController() {
  lastControllerActivity = Date.now();
}

function scheduleLeaseCheck() {
  if (stopped) return;
  leaseTimer = setTimeout(() => {
    if (!stopped && !controllerSuspended && controllerLeaseExpired(lastControllerActivity)) {
      commandQueue = commandQueue
        .then(async () => {
          if (stopped || controllerSuspended || !controllerLeaseExpired(lastControllerActivity)) return;
          controllerSuspended = true;
          await closeBrowser();
          emitAttention(
            'controller-idle',
            '连续 120 秒未收到控制端 keepalive/命令，已关闭浏览器以降低负载；请发送 retry 重新加入。',
          );
        })
        .catch((error) => emitAttention('runner-error', error instanceof Error ? error.message : String(error)));
    }
    scheduleLeaseCheck();
  }, LEASE_CHECK_INTERVAL_MS);
}

async function handleCommand(command, agentUrl, playerName) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    commandError('unknown', '命令必须是 JSON 对象');
    return;
  }

  if (command.type === 'keepalive') {
    touchController();
    return;
  }

  if (command.type === 'action') {
    if (typeof command.name !== 'string' || !command.name) {
      commandError('action', 'action.name 必须是非空字符串');
      return;
    }
    touchController();
    if (!page) {
      commandError('action', '浏览器未连接；请先发送 retry');
      return;
    }
    try {
      const result = await page.evaluate(
        ({ name, payload }) => window.__partiAgent.action(name, payload),
        { name: command.name, payload: command.payload },
      );
      emit({
        type: 'ack',
        command: 'action',
        ok: true,
        name: command.name,
        result,
        note: '仅代表动作已发出；请等待后续 update/events 判断是否合法及是否生效。',
      });
    } catch (error) {
      commandError('action', error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (command.type === 'inspect') {
    touchController();
    if (!page) {
      commandError('inspect', '浏览器未连接；请先发送 retry');
      return;
    }
    try {
      const snapshot = await readSnapshot(page, command.includeState === true);
      emitUpdate(snapshot, 'inspect');
    } catch (error) {
      commandError('inspect', error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (command.type === 'retry') {
    touchController();
    controllerSuspended = false;
    emit({ type: 'ack', command: 'retry', ok: true });
    await openBrowser(agentUrl, playerName);
    return;
  }

  if (command.type === 'stop') {
    if (typeof command.reason !== 'string' || !command.reason.trim()) {
      commandError('stop', 'stop.reason 必须说明房间永久失效的证据');
      return;
    }
    touchController();
    stopped = true;
    await closeBrowser();
    emit({ type: 'terminal', reason: command.reason.trim() });
    if (commandFileTimer) clearTimeout(commandFileTimer);
    if (leaseTimer) clearTimeout(leaseTimer);
    input?.close();
    restorePtyMode();
    process.stdin.pause();
    process.exitCode = 0;
    return;
  }

  commandError(typeof command.type === 'string' ? command.type : 'unknown', '未知命令类型');
}

function acceptCommandLine(line, args) {
  if (!line.trim() || stopped) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    commandError('parse', error instanceof Error ? error.message : String(error));
    return;
  }
  commandQueue = commandQueue
    .then(() => handleCommand(command, args.url, args.name))
    .catch((error) => emitAttention('runner-error', error instanceof Error ? error.message : String(error)));
}

function consumeCommandBytes(bytes, args) {
  pendingCommandBytes = Buffer.concat([pendingCommandBytes, bytes]);
  let newline;
  while ((newline = pendingCommandBytes.indexOf(0x0a)) >= 0) {
    const line = pendingCommandBytes.subarray(0, newline).toString('utf8');
    pendingCommandBytes = pendingCommandBytes.subarray(newline + 1);
    acceptCommandLine(line, args);
  }
}

async function pollCommandFile(file, args) {
  if (stopped) return;
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size < commandFileOffset) {
      commandFileOffset = 0;
      pendingCommandBytes = Buffer.alloc(0);
    }
    if (stat.size > commandFileOffset) {
      const length = stat.size - commandFileOffset;
      const handle = await fs.promises.open(file, 'r');
      try {
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await handle.read(bytes, 0, length, commandFileOffset);
        commandFileOffset += bytesRead;
        consumeCommandBytes(bytes.subarray(0, bytesRead), args);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      emitAttention('command-file-error', error instanceof Error ? error.message : String(error));
    }
  }
  if (!stopped) {
    commandFileTimer = setTimeout(() => void pollCommandFile(file, args), COMMAND_FILE_POLL_INTERVAL_MS);
  }
}

async function main(argv) {
  let readEventsArgs;
  try {
    readEventsArgs = parseReadEventsArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (readEventsArgs) {
    try {
      const { bytes, nextOffset } = await readIncrementalEvents(readEventsArgs.eventsFile, readEventsArgs.cursorFile);
      if (bytes.length) {
        fs.writeSync(process.stdout.fd, bytes);
        await writeCursor(readEventsArgs.cursorFile, nextOffset);
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
    return;
  }

  let args;
  let argumentError;
  try {
    args = parseArgs(argv);
  } catch (error) {
    argumentError = error instanceof Error ? error.message : String(error);
  }

  emit({
    type: 'hello',
    runnerVersion: PROTOCOL_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    commands: {
      keepalive: { type: 'keepalive', silent: true },
      action: { type: 'action', name: '<action-name>', payload: {} },
      inspect: { type: 'inspect', includeState: true },
      retry: { type: 'retry' },
      stop: { type: 'stop', reason: '<permanent-room-failure-evidence>' },
    },
    controllerLeaseMs: CONTROLLER_LEASE_MS,
    commandTransport: args?.commandsFile ? { type: 'file', path: args.commandsFile } : { type: 'stdin' },
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stopped = true;
      void closeBrowser().finally(() => {
        if (commandFileTimer) clearTimeout(commandFileTimer);
        if (leaseTimer) clearTimeout(leaseTimer);
        input?.close();
        restorePtyMode();
        process.stdin.pause();
        process.exitCode = signal === 'SIGINT' ? 130 : 143;
      });
    });
  }

  if (argumentError || !args) {
    emit({
      type: 'attention',
      status: 'argument-error',
      error: argumentError ?? '无法解析启动参数',
      recoverable: false,
      commands: [],
    });
    process.exitCode = 2;
    return;
  }

  touchController();
  scheduleLeaseCheck();
  commandQueue = openBrowser(args.url, args.name);
  if (args.commandsFile) {
    void pollCommandFile(args.commandsFile, args);
  } else {
    disablePtyEcho();
    input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on('line', (line) => acceptCommandLine(line, args));
  }
  await commandQueue;
}

process.once('exit', restorePtyMode);
await main(process.argv.slice(2));
