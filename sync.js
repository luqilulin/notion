/**
 * sync.js
 * —— 将“钱包”库中未关联的记录，按记账日期关联到“每日活动”对应日期行
 */

const { Client } = require('@notionhq/client');
const dayjs = require('dayjs');

// 从环境变量读取必要参数
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const WALLET_DB_ID = process.env.NOTION_DB_WALLET_ID;
const DAILY_DB_ID = process.env.NOTION_DB_DAILY_ID;
// Relation 属性名称需与 Notion 数据库里字段一致
const DAILY_RELATION_PROPERTY = '关联';

if (!NOTION_TOKEN || !WALLET_DB_ID || !DAILY_DB_ID) {
  console.error('❌ 请先在环境变量里设置 NOTION_TOKEN、NOTION_DB_WALLET_ID、NOTION_DB_DAILY_ID');
  process.exit(1);
}

// 初始化 Notion 客户端
const notion = new Client({ auth: NOTION_TOKEN });

/**
 * 1. 获取“钱包”库里 Relation 为空的未关联条目
 */
async function fetchUnlinkedWalletEntries() {
  const results = [];
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: WALLET_DB_ID,
      start_cursor: cursor,
      page_size: 50,
      filter: {
        property: '关联',
        relation: { is_empty: true }
      }
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

/**
 * 2. 根据“钱包”记录的记账日期，在“每日活动”库中查找对应页面
 */
async function findDailyPageByDate(walletDate) {
  const isoDate = dayjs(walletDate).format('YYYY-MM-DD');
  const response = await notion.databases.query({
    database_id: DAILY_DB_ID,
    filter: {
      property: '日期',
      date: { equals: isoDate }
      and: [
    { property: '关联', relation: { is_empty: true } },
    { property: '创建时间', created_time: { after: dayjs().subtract(1, 'day').toISOString() } }
  ]
    }
  });
  return response.results.length > 0 ? response.results[0] : null;
}

/**
 * 3. 追加 Relation，将钱包 page_id 加到“每日活动”页面现有关联列表中
 */
async function appendRelationToDaily(dailyPageId, walletPageId) {
  // 先读取“每日活动”页面的现有 Relation 列表
  const page = await notion.pages.retrieve({ page_id: dailyPageId });
  const currentRelations = page.properties[DAILY_RELATION_PROPERTY].relation || [];

  // 如果已存在就跳过
  if (currentRelations.some(rel => rel.id === walletPageId)) {
    console.log(`🔗 ${walletPageId} 已在 ${dailyPageId} 关联中，跳过`);
    return;
  }

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
    console.log('⏳ 开始查询“钱包”库中未关联条目…');
    const unlinked = await fetchUnlinkedWalletEntries();

    if (unlinked.length === 0) {
      console.log('🤞 没有可关联的新钱包记录，结束任务。');
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

      // 查找“每日活动”对应页面
      const dailyPage = await findDailyPageByDate(walletDate);
      if (!dailyPage) {
        console.warn(`❌ 未找到“每日活动”中 日期=${walletDate} 的页面，跳过 Wallet ${walletPageId}`);
        continue;
      }

      // 执行关联
      await appendRelationToDaily(dailyPage.id, walletPageId);
    }

    console.log('🎉 同步完成。');
  } catch (err) {
    console.error('❌ 脚本执行出错：', err);
    process.exit(1);
  }
})();
