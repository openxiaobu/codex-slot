const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildLaunchAgentPlist,
  buildSystemdUserUnit
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
