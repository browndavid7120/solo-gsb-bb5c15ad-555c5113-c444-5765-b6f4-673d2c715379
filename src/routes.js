'use strict';

const express = require('express');
const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { evaluateDraft, publishVersion, latestVersionNo, getVersionDetail, getVersionSummary } = require('./publish');
const { draftRevision, bumpDraftRevision } = require('./draft');
const { getRestorePreview, confirmRestore } = require('./restore');

const router = express.Router();

// ---------- 辅助 ----------
function badRequest(message) {
  return { status: 400, message };
}

function requireString(body, field, { max = 500, allowEmpty = false } = {}) {
  const v = body[field];
  if (typeof v !== 'string') throw badRequest(`字段 ${field} 必须是字符串`);
  if (!allowEmpty && v.trim() === '') throw badRequest(`字段 ${field} 不能为空`);
  if (v.length > max) throw badRequest(`字段 ${field} 长度不能超过 ${max}`);
  return v;
}

function optionalString(body, field, max = 2000) {
  const v = body[field];
  if (v == null) return '';
  if (typeof v !== 'string') throw badRequest(`字段 ${field} 必须是字符串`);
  if (v.length > max) throw badRequest(`字段 ${field} 长度不能超过 ${max}`);
  return v;
}

// 事件不存在 → 404
function getEventOr404(id) {
  const ev = getDb().prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!ev) throw { status: 404, message: `事件 ${id} 不存在` };
  return ev;
}

function claimRowToApi(c) {
  return {
    id: c.id,
    eventId: c.event_id,
    precision: c.precision,
    year: c.year,
    month: c.month,
    day: c.day,
    dateLabel: c.date_label,
    intervalStart: c.interval_start,
    intervalEnd: c.interval_end,
    source: c.source,
    note: c.note,
  };
}

function eventRowToApi(e) {
  const claims = getDb()
    .prepare('SELECT * FROM claims WHERE event_id = ? ORDER BY id')
    .all(e.id)
    .map(claimRowToApi);
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    claims,
  };
}

function readClaimPayload(body) {
  const { precision, year, month, day } = parseClaimDate(body || {});
  const source = requireString(body, 'source', { max: 1000 });
  const note = optionalString(body, 'note', 2000);
  const { start, end } = claimInterval(precision, year, month, day);
  return {
    precision,
    year,
    month,
    day,
    dateLabel: formatClaimDate(precision, year, month, day),
    intervalStart: start,
    intervalEnd: end,
    source,
    note,
  };
}

// ================= 公开接口（访客，无需口令） =================
// 只暴露最新已发布版本的不可变快照，不触碰草稿。

router.get('/api/public/chronicle', (req, res) => {
  const no = latestVersionNo();
  if (no === 0) {
    return res.json({ published: false, message: '年表尚未发布任何版本' });
  }
  res.json({ published: true, currentVersionNo: no, version: getVersionDetail(no) });
});

router.get('/api/public/versions', (req, res) => {
  const no = latestVersionNo();
  const rows = getDb()
    .prepare(
      `SELECT version_no AS versionNo, parent_no AS parentNo, editor, note, published_at AS publishedAt
         FROM versions ORDER BY version_no DESC`
    )
    .all();
  res.json({ currentVersionNo: no, versions: rows });
});

router.get('/api/public/versions/:no', (req, res) => {
  const no = Number(req.params.no);
  const detail = getVersionDetail(no);
  if (!detail) throw { status: 404, message: `版本 ${req.params.no} 不存在` };
  res.json({ version: detail });
});

// ================= 编辑者接口 =================

// 草稿全貌：事件、主张、关系 + 当前最新版本号
router.get('/api/editor/state', (req, res) => {
  const db = getDb();
  const events = db.prepare('SELECT * FROM events ORDER BY id').all().map(eventRowToApi);
  const relations = db
    .prepare('SELECT * FROM relations ORDER BY id')
    .all()
    .map((r) => ({
      id: r.id,
      earlierId: r.earlier_id,
      laterId: r.later_id,
      source: r.source,
      note: r.note,
    }));
  res.json({
    currentVersionNo: latestVersionNo(),
    currentVersion: getVersionSummary(latestVersionNo()) || null,
    draftRevision: draftRevision(),
    events,
    relations,
  });
});

// ---- 事件 CRUD ----
router.post('/api/editor/events', (req, res) => {
  const title = requireString(req.body, 'title', { max: 200 });
  const description = optionalString(req.body, 'description', 5000);
  const info = getDb().prepare('INSERT INTO events (title, description) VALUES (?, ?)').run(title.trim(), description);
  bumpDraftRevision();
  res.status(201).json({ event: eventRowToApi(getEventOr404(info.lastInsertRowid)) });
});

router.put('/api/editor/events/:id', (req, res) => {
  const id = Number(req.params.id);
  getEventOr404(id);
  const title = requireString(req.body, 'title', { max: 200 });
  const description = optionalString(req.body, 'description', 5000);
  getDb()
    .prepare('UPDATE events SET title = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(title.trim(), description, id);
  bumpDraftRevision();
  res.json({ event: eventRowToApi(getEventOr404(id)) });
});

router.delete('/api/editor/events/:id', (req, res) => {
  const id = Number(req.params.id);
  getEventOr404(id);
  getDb().prepare('DELETE FROM events WHERE id = ?').run(id);
  bumpDraftRevision();
  res.json({ deleted: id });
});

// ---- 主张 CRUD（同一事件允许矛盾主张并存） ----
router.post('/api/editor/events/:id/claims', (req, res) => {
  const eventId = Number(req.params.id);
  getEventOr404(eventId);
  const p = readClaimPayload(req.body);
  const info = getDb()
    .prepare(
      `INSERT INTO claims
         (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(eventId, p.precision, p.year, p.month, p.day, p.dateLabel, p.intervalStart, p.intervalEnd, p.source, p.note);
  bumpDraftRevision();
  res.status(201).json({ claim: claimRowToApi(getDb().prepare('SELECT * FROM claims WHERE id = ?').get(info.lastInsertRowid)) });
});

router.put('/api/editor/claims/:claimId', (req, res) => {
  const claimId = Number(req.params.claimId);
  const existing = getDb().prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!existing) throw { status: 404, message: `主张 ${claimId} 不存在` };
  const p = readClaimPayload(req.body);
  getDb()
    .prepare(
      `UPDATE claims SET precision=?, year=?, month=?, day=?, date_label=?,
         interval_start=?, interval_end=?, source=?, note=? WHERE id=?`
    )
    .run(p.precision, p.year, p.month, p.day, p.dateLabel, p.intervalStart, p.intervalEnd, p.source, p.note, claimId);
  bumpDraftRevision();
  res.json({ claim: claimRowToApi(getDb().prepare('SELECT * FROM claims WHERE id = ?').get(claimId)) });
});

router.delete('/api/editor/claims/:claimId', (req, res) => {
  const claimId = Number(req.params.claimId);
  const existing = getDb().prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!existing) throw { status: 404, message: `主张 ${claimId} 不存在` };
  getDb().prepare('DELETE FROM claims WHERE id = ?').run(claimId);
  bumpDraftRevision();
  res.json({ deleted: claimId });
});

// ---- 关系 CRUD ----
router.post('/api/editor/relations', (req, res) => {
  const earlierId = Number(req.body.earlierId);
  const laterId = Number(req.body.laterId);
  if (!Number.isInteger(earlierId) || !Number.isInteger(laterId)) {
    throw badRequest('earlierId 与 laterId 必须是事件 id 整数');
  }
  if (earlierId === laterId) throw badRequest('一个事件不能先于自身');
  getEventOr404(earlierId);
  getEventOr404(laterId);
  const source = optionalString(req.body, 'source', 1000);
  const note = optionalString(req.body, 'note', 2000);
  const info = getDb()
    .prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)')
    .run(earlierId, laterId, source, note);
  const row = getDb().prepare('SELECT * FROM relations WHERE id = ?').get(info.lastInsertRowid);
  bumpDraftRevision();
  res.status(201).json({
    relation: { id: row.id, earlierId: row.earlier_id, laterId: row.later_id, source: row.source, note: row.note },
  });
});

router.delete('/api/editor/relations/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getDb().prepare('SELECT * FROM relations WHERE id = ?').get(id);
  if (!row) throw { status: 404, message: `关系 ${id} 不存在` };
  getDb().prepare('DELETE FROM relations WHERE id = ?').run(id);
  bumpDraftRevision();
  res.json({ deleted: id });
});

// ---- 发布前预检：不落库，返回求解错误或可行日期 ----
router.post('/api/editor/validate', (req, res) => {
  const selectionList = normalizeSelection(req.body);
  const result = evaluateDraft(selectionList);
  if (!result.ok) {
    return res.json({ ok: false, errors: result.errors });
  }
  const { dates, events, selected } = result;
  const preview = events
    .map((ev) => {
      const sel = selected.get(ev.id);
      return {
        eventId: ev.id,
        title: ev.title,
        claimId: sel.claimId,
        resolvedDate: iso(dates.get(ev.id)),
        intervalStart: iso(sel.startOrd),
        intervalEnd: iso(sel.endOrd),
      };
    })
    .sort((a, b) => a.resolvedDate.localeCompare(b.resolvedDate));
  res.json({ ok: true, preview });
});

function iso(ord) {
  // 延迟 require 避免循环
  return require('./dates').isoFromOrdinal(ord);
}

function normalizeSelection(body) {
  const raw = body && body.selection;
  if (!Array.isArray(raw)) throw badRequest('selection 必须是 [{eventId, claimId}] 数组');
  return raw.map((item) => {
    const eventId = Number(item && item.eventId);
    const claimId = Number(item && item.claimId);
    if (!Number.isInteger(eventId) || !Number.isInteger(claimId)) {
      throw badRequest('selection 中每项必须包含整数 eventId 与 claimId');
    }
    return { eventId, claimId };
  });
}

// ---- 正式发布：创建不可变版本 ----
router.post('/api/editor/publish', (req, res) => {
  const selectionList = normalizeSelection(req.body);
  const baseVersionNo = req.body.baseVersionNo === null || req.body.baseVersionNo === undefined
    ? null
    : Number(req.body.baseVersionNo);
  if (baseVersionNo !== null && !Number.isInteger(baseVersionNo)) {
    throw badRequest('baseVersionNo 必须是整数或 null');
  }
  const editor = optionalString(req.body, 'editor', 200) || '匿名编辑';
  const note = optionalString(req.body, 'note', 1000);
  const result = publishVersion({ selectionList, baseVersionNo, editor, note });
  res.status(201).json({ ok: true, ...result });
});

// ---- 从已发布版本恢复草稿：预览（只读，不改数据） ----
router.get('/api/editor/restore/:versionNo', (req, res) => {
  const versionNo = Number(req.params.versionNo);
  res.json({ ok: true, ...getRestorePreview(versionNo) });
});

// ---- 从已发布版本恢复草稿：确认（原子替换整个草稿） ----
router.post('/api/editor/restore/:versionNo/confirm', (req, res) => {
  const versionNo = Number(req.params.versionNo);
  const draftRev = req.body.draftRevision === null || req.body.draftRevision === undefined
    ? null
    : Number(req.body.draftRevision);
  if (draftRev === null || !Number.isInteger(draftRev)) {
    throw badRequest('draftRevision 必须是预览时返回的非负整数');
  }
  const current = latestVersionNo();
  const baseVersionNo = req.body.baseVersionNo === null || req.body.baseVersionNo === undefined
    ? current
    : Number(req.body.baseVersionNo);
  if (!Number.isInteger(baseVersionNo)) throw badRequest('baseVersionNo 必须是整数');
  const result = confirmRestore({ versionNo, draftRevision: draftRev, baseVersionNo });
  res.json({ ok: true, ...result });
});

// 版本列表（编辑者视角，结构与公开一致）
router.get('/api/editor/versions', (req, res) => {
  const no = latestVersionNo();
  const rows = getDb()
    .prepare(
      `SELECT version_no AS versionNo, parent_no AS parentNo, editor, note, published_at AS publishedAt
         FROM versions ORDER BY version_no DESC`
    )
    .all();
  res.json({ currentVersionNo: no, versions: rows });
});

module.exports = router;
