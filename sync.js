/**
 * sync.js
 * —— 把“钱包”库里未关联的记录，按记账日期关联到“每日活动”库对应日期行
 *     已修正 filter 中的 timestamp 用法
 */

const { Client } = require('@notionhq/client');
const dayjs = require('dayjs');

// 从环境变量读取必要信息（已在 GitHub Secrets 里配置）
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const WALLET_DB_ID = process.env.NOTION_DB_WALLET_ID;
const DAILY_DB_ID = process.env.NOTION_DB_DAILY_ID;
// “每日活动”数据库里 Relation 列的字段名（保持与 Notion 中完全一致）
const DAILY_RELATION_PROPERTY = '关联';

if (!NOTION_TOKEN || !WALLET_DB_ID || !DAILY_DB_ID) {
  console.error('❌ 请先在环境变量里设置 NOTION_TOKEN、NOTION_DB_WALLET_ID、NOTION_DB_DAILY_ID');
  process.exit(1);
}

// 初始化 Notion 客户端
const notion = new Client({ auth: NOTION_TOKEN });

/**
 * 1. 获取“钱包”库里 Relation 为空且最近 24 小时新增的记录
 *    注意：第二个 filter 必须指定 timestamp 字段
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
        and: [
          {
            property: '关联',
            relation: { is_empty: true }
          },
          {
            // 这里一定要写成 timestamp + created_time，不能只写 created_time
            timestamp: 'created_time',
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
  const isoDate = day
