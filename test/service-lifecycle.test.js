const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildLaunchAgentPlist,
  buildSchtasksTaskXml,
  buildSystemdUserUnit,
  buildWindowsStartupScript
} = require("../dist/app/service-lifecycle-service.js");

test("launchd plist 包含自动拉起与开机启动配置", () => {
  const plist = buildLaunchAgentPlist("/usr/local/bin/node", ["/tmp/cslot/serve.js", "--port", "4399"], "/tmp/cslot/service.log");

  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /\/usr\/local\/bin\/node/);
  assert.match(plist, /\/tmp\/cslot\/service\.log/);
});

test("systemd user unit 包含自动重启与默认目标挂载配置", () => {
  const homeDir = os.homedir();
  const unit = buildSystemdUserUnit("/usr/bin/node", [path.join(homeDir, "cslot", "serve.js"), "--port", "4399"], "/tmp/cslot/service.log");

  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=1$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.match(unit, /^ExecStart=/m);
  assert.match(unit, /^Environment=HOME="/m);
  assert.match(unit, /^StandardOutput=append:\/tmp\/cslot\/service\.log$/m);
});

test("schtasks XML 包含登录自启与失败重启配置", () => {
  const xml = buildSchtasksTaskXml("C:\\\\Program Files\\\\nodejs\\\\node.exe", ["C:\\\\Users\\\\demo\\\\serve.js", "--port", "4399"], "C:\\\\Users\\\\demo\\\\.cslot\\\\logs\\\\service.log");

  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<Command>.*conhost\.exe<\/Command>/);
  assert.match(xml, /--headless -- cmd\.exe/);
  assert.match(xml, /USERPROFILE=/);
  assert.match(xml, /service\.log/);
});

test("Windows 启动脚本使用 VBS 隐藏启动并包含 PID 去重逻辑", () => {
  const script = buildWindowsStartupScript("C:\\\\Program Files\\\\nodejs\\\\node.exe", ["C:\\\\Users\\\\demo\\\\serve.js", "--port", "4399"], "C:\\\\Users\\\\demo\\\\.cslot\\\\logs\\\\service.log");

  assert.match(script, /WScript\.Shell/);
  assert.match(script, /sh\.Run ".+", 0, False/);
  // VBS 字符串里的双引号会被转义成 `""`，因此匹配 `set ""USERPROFILE=` / `set ""HOME=`。
  assert.match(script, /set ""USERPROFILE=/);
  assert.match(script, /set ""HOME=/);
  assert.match(script, /Win32_Process/);
  assert.match(script, /serve\.js/);
  assert.doesNotMatch(script, /start \/B/);
});
