const assert = require("node:assert/strict");
const os = require("node:os");
const test = require("node:test");

const { getUserHomeDir } = require("../dist/config.js");

test("getUserHomeDir 会裁剪 HOME 尾随空格", () => {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const expectedHome = os.homedir();

  try {
    process.env.HOME = `${expectedHome} `;
    delete process.env.USERPROFILE;

    assert.equal(getUserHomeDir(), expectedHome);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
