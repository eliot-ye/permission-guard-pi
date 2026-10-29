// git 子命令分类（单一事实源）。
// 独立文件避免循环依赖：readonly.ts ↔ silent.ts 相互导入（readonly 用
// isForBodyReadOnly、silent 用 isReadOnlyWithArgs），若本常量放在任一文件
// 会在模块顶层初始化时触发 ReferenceError（TDZ）。独立文件无依赖，三者
//（readonly / silent / shell-forwarder）均可安全导入。
//
// git 只读子命令集合（裸子命令名）：与 entry.ts 4b 的
// `SILENT_COMMANDS[cmdName].has(t)` 语义一致——git 子命令不在本集合即视为
// 写子命令（rm/add/commit/checkout/clean/mv/reset/revert/stash 等），写子
// 命令修改工作树文件（删除/覆盖），不是只读 pathspec 查询。
export const GIT_READONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "branch", "tag", "remote", "config",
  "rev-parse", "rev-list", "shortlog", "blame", "show", "ls-files",
]);
