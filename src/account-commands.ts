import { importAccount, listAccounts, loginAccount, removeAccount, renameAccount } from "./app/account-service";
import { bi } from "./text";

/**
 * 将已有的 Codex HOME 目录中的登录态复制到 cslot 自己的隔离目录并纳入管理。
 *
 * @param name 本地账号标识，等同于配置中的槽位名。
 * @param codexHome 现有 HOME 目录；若未传则默认使用当前用户 HOME。
 * @returns 无返回值。
 * @throws 当源目录缺少必要认证文件时抛出异常。
 */
export function handleAccountImport(name: string, codexHome?: string): void {
  const { account, sourceHome } = importAccount(name, codexHome);
  console.log(bi(`账号已导入: ${account.id}`, `Account imported: ${account.id}`));
  console.log(bi(`来源 HOME: ${sourceHome}`, `Source HOME: ${sourceHome}`));
  console.log(bi(`已复制到: ${account.codex_home}`, `Copied to: ${account.codex_home}`));
}

/**
 * 执行隔离登录流程，将账号录入到 cslot 管理目录。
 *
 * @param name 本地账号标识，等同于配置中的槽位名。
 * @returns Promise，成功时输出账号目录信息。
 * @throws 当登录流程失败或认证状态不完整时抛出异常。
 */
export async function handleAccountLogin(name: string): Promise<void> {
  const home = await loginAccount(name);
  console.log(bi(`登录完成，账号目录: ${home}`, `Login completed. Account home: ${home}`));
}

/**
 * 删除配置中的账号项。
 *
 * @param name 本地账号标识，等同于配置中的槽位名。
 * @returns 无返回值。
 * @throws 当账号不存在时抛出异常。
 */
export function handleAccountRemove(name: string): void {
  const removed = removeAccount(name);

  if (!removed) {
    throw new Error(bi(`未找到账号 ${name}`, `Account not found: ${name}`));
  }

  console.log(bi(`已删除账号配置: ${removed.id}`, `Removed account config: ${removed.id}`));
}

/**
 * `del` 子命令入口：在未提供 name 时先展示当前已录入账号列表，便于选择。
 *
 * @param name 可选的账号标识；留空时仅打印账号列表和删除示例。
 * @returns 无返回值。
 * @throws 当指定账号不存在时透传删除异常。
 */
export function handleAccountRemoveCommand(name?: string): void {
  if (!name) {
    const accounts = listAccounts();

    if (accounts.length === 0) {
      console.log(bi("当前没有已录入账号。", "No managed accounts found."));
      return;
    }

    console.log(bi("当前已录入账号（name）：", "Managed accounts (name):"));
    for (const account of accounts) {
      if (account.email) {
        console.log(`- ${account.id} (${account.email})`);
      } else {
        console.log(`- ${account.id}`);
      }
    }
    console.log("");
    console.log(
      bi(
        "请使用以下命令删除指定账号，例如：",
        "Use the following command to remove a specific account, for example:"
      )
    );
    console.log("  codex-slot del <name>");
    return;
  }

  handleAccountRemove(name);
}

/**
 * 重命名已有受管槽位。
 *
 * @param oldName 原槽位名。
 * @param newName 新槽位名。
 * @returns 无返回值。
 * @throws 当旧槽位不存在、新槽位已存在或目录迁移失败时抛出异常。
 */
export function handleAccountRename(oldName: string, newName: string): void {
  const renamed = renameAccount(oldName, newName);
  console.log(bi(`已重命名账号: ${oldName} -> ${newName}`, `Renamed account: ${oldName} -> ${newName}`));
  console.log(bi(`当前目录: ${renamed.codex_home}`, `Current home: ${renamed.codex_home}`));
}
