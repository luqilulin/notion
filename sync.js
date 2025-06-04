/**
 * sync.js
 * —— 把“钱包”库里未关联的记录，按记账日期关联到“每日活动”库对应日期行
 */

const { Client } = require('@notionhq/client');
const dayjs = require('dayjs');

// 从环境变量读取必要信息（已在 GitHub Secrets 里配置）
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const WALLET_DB_ID = process.env.NOTION_DB_WALLET_ID;
const DAILY_DB_ID = process.env.NOTION_DB_DAILY_ID;
// “每日活动”数据库里 Relation 列的字段名，请与 Notion 中一致
const DAILY_RELATION_PROPERTY = '当日支出关联';

if (!NOTION_TOKEN || !WALLET_DB_ID || !DAILY_DB_ID) {
  console.error('❌ 请先在环境变量里设置 NOTION_TOKEN、NOTION_DB_WALLET_ID、NOTION_DB_DAILY_ID');
  process.exit(1);
}

// 初始化 Notion 客户端
const notion = new Client({ auth: NOTION_TOKEN });

/**
 * 1. 获取“钱包”库里 Relation 为空且最近 24 小时新增的记录
 *    使用一个 proper filter 对象，其中 and 数组必须嵌套到 filter 里，
 *    而不能像顶层属性那样直接写 and: [ … ]。
 */
async function fetchUnlinkedWalletEntries() {
  const results = [];
  let cursor = undefined;

  // 计算 24 小时前的 ISO 时间，用于 created_time 过滤
  const yesterdayISO = dayjs().subtract(1, 'day').toISOString();

  do {
    const response = await notion.databases.query({
      database_id: WALLET_DB_ID,
      start_cursor: cursor,
      page_size: 50,
      filter: {
        // 这里用一个对象把 and 数组包含进去：
        and: [
          {
            property: '关联',
            relation: { is_empty: true }
          },
          {
            property: '创建时间',        // Notion 默认给每条条目都有一个 “Created time” 字段
            created_time: { after: yesterdayISO }
          }
        ]
      }
    });

    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

/**
 * 2. 在“每日活动”库里查找与记账日期相同的页面
 */
async function findDailyPageByDate(walletDate) {
  // 把 walletDate（例如 “2025-06-04T08:00:00.000Z”）格式化为 “YYYY-MM-DD”
  const isoDate = dayjs(walletDate).format('YYYY-MM-DD');

  const response = await notion.databases.query({
    database_id: DAILY_DB_ID,
    filter: {
      property: '日期',
      date: { equals: isoDate }
    }
  });
  return response.results.length > 0 ? response.results[0] : null;
}

/**
 * 3. 追加 Relation，把钱包 page_id 加到“每日活动”页面的 Relation 数组里
 */
async function appendRelationToDaily(dailyPageId, walletPageId) {
  // 先检索该 “每日活动” 页面，获取现有的 Relation 列表
  const page = await notion.pages.retrieve({ page_id: dailyPageId });
  const currentRelations = page.properties[DAILY_RELATION_PROPERTY].relation || [];

  // 如果已经关联过，就跳过
  if (currentRelations.some(rel => rel.id === walletPageId)) {
    console.log(`🔗 ${walletPageId} 已在 ${dailyPageId} 关联中，跳过`);
    return;
  }

  // 追加新的 relation
  const newRelations = [...currentRelations, { id: walletPageId }];

  await notion.pages.update({
    page_id: dailyPageId,
    properties: {
      [DAILY_RELATION_PROPERTY]: { relation: newRelations }
    }
  });

  console.log(`✅ 已将钱包记录 ${walletPageId} 关联到“每日活动” ${dailyPageId}`);
}

(async () => {
  try {
    console.log('⏳ 正在查询“钱包”库中未关联且近24小时新增的条目…');
    const unlinked = await fetchUnlinkedWalletEntries();

    if (unlinked.length === 0) {
      console.log('🤞 没有可关联的新钱包记录，任务结束。');
      return;
    }

    for (const walletPage of unlinked) {
      const walletPageId = walletPage.id;
      const dateProp = walletPage.properties['记账日期'];
      if (!dateProp || !dateProp.date || !dateProp.date.start) {
        console.warn(`⚠️ 钱包 ${walletPageId} 缺失“记账日期”，跳过`);
        continue;
      }
      const walletDate = dateProp.date.start;

      // 在“每日活动”里查找对应日期的页面
      const dailyPage = await findDailyPageByDate(walletDate);
      if (!dailyPage) {
        console.warn(`❌ 未找到“每日活动”中 日期=${walletDate} 的页面，跳过 Wallet ${walletPageId}`);
        continue;
      }

      // 追加关联
      await appendRelationToDaily(dailyPage.id, walletPageId);
    }

    console.log('🎉 同步完成。');
  } catch (err) {
    console.error('❌ 脚本执行出错：', err);
    process.exit(1);
  }
})();
