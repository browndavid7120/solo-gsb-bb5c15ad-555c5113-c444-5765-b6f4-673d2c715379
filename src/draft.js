'use strict';

// 草稿区工具：修订号（乐观并发控制）与草稿现状读取。
// 草稿区的任何增删改（事件 / 主张 / 关系 / 整体恢复）都推进修订号。

const { getDb } = require('./db');

// 当前草稿修订号。
function draftRevision() {
  const row = getDb().prepare('SELECT revision FROM draft_meta WHERE id = 1').get();
  return row ? row.revision : 0;
}

// 把草稿修订号加 1。在 better-sqlite3 中，若处于事务内会自动并入当前事务。
function bumpDraftRevision() {
  getDb()
    .prepare("UPDATE draft_meta SET revision = revision + 1 WHERE id = 1")
    .run();
  return draftRevision();
}

// 读取当前草稿全貌（事件 + 主张 + 关系），用于编辑台与恢复预览对比。
function readDraft() {
  const db = getDb();
  const events = db
    .prepare(
      `SELECT id, title, description,
              (SELECT COUNT(*) FROM claims c WHERE c.event_id = e.id) AS claimCount
         FROM events e ORDER BY e.id`
    )
    .all()
    .map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      claimCount: e.claimCount,
    }));
  const claims = db
    .prepare(
      `SELECT c.id, c.event_id AS eventId, c.precision, c.date_label AS dateLabel,
              c.interval_start AS intervalStart, c.interval_end AS intervalEnd,
              c.source, c.note
         FROM claims c ORDER BY c.id`
    )
    .all();
  const titles = new Map(events.map((e) => [e.id, e.title]));
  const relations = db
    .prepare('SELECT id, earlier_id AS earlierId, later_id AS laterId, source, note FROM relations ORDER BY id')
    .all()
    .map((r) => ({ ...r, earlierTitle: titles.get(r.earlierId) || `#${r.earlierId}`, laterTitle: titles.get(r.laterId) || `#${r.laterId}` }));
  return { events, claims, relations };
}

module.exports = { draftRevision, bumpDraftRevision, readDraft };
