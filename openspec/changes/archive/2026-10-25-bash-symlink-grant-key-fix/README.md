# bash-symlink-grant-key-fix

修 bash 可靠提取下符号链接目标的 grant 键不一致：handleBash reliable 分支以 resolvedPath 存持久 grant，下次 decideTarget 第一次调用以 target.path 查 hasGrant 键不匹配，导致持久 grant 永不命中、反复弹窗。改 decideTarget grant 查询段同时查 absPath 与 canonicalPath 两键。
