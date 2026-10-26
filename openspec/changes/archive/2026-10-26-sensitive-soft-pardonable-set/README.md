# sensitive-soft-pardonable-set

新建可赦免软敏感集合：config.*/auth.*/settings.*/models.* 等含 apikey 的通用配置文件名进 soft sensitive 集合，命中后 tier=three 不论内外（可持久化赦免），区别于 hard sensitive（~/.ssh/id_rsa 等外区 tier=two 不可持久化）。偏离 permission-model.md 声明的项目外敏感不可持久化硬底线，需 access-decision spec 显式声明 hard/soft 分级。
