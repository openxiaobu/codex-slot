import { spawn } from "node:child_process";
import { registerManagedAccount } from "./account-store";
import { getManagedHome } from "./config";

/**
 * 使用独立 HOME 目录拉起官方 `codex login`，完成单账号录入。
 *
 * @param accountId 本地账号标识。
 * @returns Promise，成功时返回导入后的 HOME 目录。
 * @throws 当 `codex login` 执行失败时抛出错误。
 */
export async function loginManagedAccount(accountId: string): Promise<string> {
  const managedHome = getManagedHome(accountId);
  registerManagedAccount(accountId, managedHome);

  return await new Promise<string>((resolve, reject) => {
    const child = spawn("codex", ["login"], {
      env: {
        ...process.env,
        HOME: managedHome
      },
      stdio: "inherit"
    });

    child.on("exit", (code) => {
      if (code === 0) {
        registerManagedAccount(accountId, managedHome);
        resolve(managedHome);
        return;
      }

      reject(new Error(`codex login 失败，退出码: ${code ?? "unknown"}`));
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}
