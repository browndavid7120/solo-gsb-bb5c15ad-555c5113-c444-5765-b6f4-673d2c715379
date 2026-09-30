'use strict';

// 从任一已发布版本恢复草稿。
//
// 预览（getRestorePreview）只读：返回该版快照（事件、被选时间主张、先于关系）
// 以及当前草稿中即将被整体替换的内容、当前草稿修订号与最新版本号。
//
// 确认（confirmRestore）在单个事务内：
//   1. 校验草稿修订号未变、最新版本号未变、目标版本仍存在（任一不满足即报错且不改数据）；
//   2. 清空整个草稿区并按版本快照重建；只恢复该版被选定的主张；
//   3. 推进一次草稿修订号；
//   4. 返回旧快照 id -> 新草稿 id 的映射与待选主张（selection），供编辑台继续校验发布。
// 历史快照表与访客年表不受影响。

const { getDb } = require('./db');
const { getVersionDetail, getVersionSummary, latestVersionNo } = require('./publish');
const { draftRevision, bumpDraftRevision, readDraft } = require('./draft');

function notFound(versionNo) {
  throw { status: 404, message: `版本 ${versionNo} 不存在` };
}

// 恢复预览：不改任何数据。
function getRestorePreview(versionNo) {
  if (!Number.isInteger(versionNo) || versionNo < 1) notFound(versionNo);
  const version = getVersionDetail(versionNo);
  if (!version) notFound(versionNo);

  return {
    versionNo,
    version,
    draftRevision: draftRevision(),
    currentVersionNo: latestVersionNo(),
    draft: readDraft(),
  };
}

// 由快照主张的覆盖区间起点反解年 / 月 / 日（快照未单独存这三列）。
function ymdFromIntervalStart(intervalStart) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(intervalStart);
  if (!m) throw { status: 500, message: `快照主张区间起点非法：${intervalStart}` };
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

// 确认恢复。参数：
//   versionNo      要恢复的版本号
//   draftRevision  预览时返回的草稿修订号
//   baseVersionNo  预览时返回的最新版本号
function confirmRestore({ versionNo, draftRevision: expectedRevision, baseVersionNo }) {
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    throw { status: 400, message: 'versionNo 必须是正整数' };
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw { status: 400, message: 'draftRevision 必须是非负整数' };
  }
  if (!Number.isInteger(baseVersionNo) || baseVersionNo < 0) {
    throw { status: 400, message: 'baseVersionNo 必须是非负整数' };
  }

  const db = getDb();

  const tx = db.transaction(() => {
    const currentNo = latestVersionNo();
    const snapshot = getVersionDetail(versionNo);
    if (!snapshot) notFound(versionNo);

    const currentRevision = draftRevision();
    if (currentRevision !== expectedRevision) {
      throw {
        status: 409,
        code: 'DRAFT_REVISION_CONFLICT',
        message: `草稿冲突：预览后草稿已被修改（修订号 ${expectedRevision} → ${currentRevision}）。请重新预览后再确认恢复。`,
        expectedRevision,
        currentRevision,
      };
    }

    if (currentNo !== baseVersionNo) {
      throw {
        status: 409,
        code: 'VERSION_CONFLICT',
        message: `版本冲突：预览时最新为第 ${baseVersionNo} 版，确认时最新已是第 ${currentNo} 版。请重新预览后再确认恢复。`,
        baseVersionNo,
        currentVersionNo: currentNo,
        currentVersion: getVersionSummary(currentNo),
      };
    }

    // ---- 原子替换整个草稿 ----
    db.prepare('DELETE FROM relations').run();
    db.prepare('DELETE FROM claims').run();
    db.prepare('DELETE FROM events').run();

    const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
    const insClaim = db.prepare(`
      INSERT INTO claims
        (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insRel = db.prepare(
      'INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)'
    );

    // 快照事件按 sort_order 重建（即该版发布时的年表顺序）
    const eventMap = new Map();   // 快照 eventId -> 新草稿事件 id
    const claimMap = new Map();   // 快照 claimId -> 新草稿主张 id
    const selection = [];

    for (const ev of snapshot.events) {
      const newEventId = insEvent.run(ev.title, ev.description).lastInsertRowid;
      eventMap.set(ev.eventId, newEventId);

      // 只恢复该版被选定的那一条主张
      const { year, month, day } = ymdFromIntervalStart(ev.intervalStart);
      const newClaimId = insClaim
        .run(
          newEventId,
          ev.precision,
          year,
          ev.precision === 'year' ? null : month,
          ev.precision === 'day' ? day : null,
          ev.dateLabel,
          ev.intervalStart,
          ev.intervalEnd,
          ev.source,
          ev.claimNote
        )
        .lastInsertRowid;
      claimMap.set(ev.claimId, newClaimId);
      selection.push({ eventId: newEventId, claimId: newClaimId });
    }

    const relationMap = new Map(); // 快照 relationId -> 新草稿关系 id
    for (const r of snapshot.relations) {
      const earlierId = eventMap.get(r.earlierEventId);
      const laterId = eventMap.get(r.laterEventId);
      if (!earlierId || !laterId) {
        throw { status: 500, message: '快照关系引用了快照中不存在的事件' };
      }
      const newRelationId = insRel.run(earlierId, laterId, r.source || '', r.note || '').lastInsertRowid;
      relationMap.set(r.relationId, newRelationId);
    }

    // 整体替换视为一次草稿修改，只推进一个修订号
    const newRevision = bumpDraftRevision();

    const toObj = (m) => Object.fromEntries([...m].map(([k, v]) => [String(k), v]));
    return {
      restoredFromVersionNo: versionNo,
      currentVersionNo: currentNo,
      draftRevision: newRevision,
      mapping: {
        events: toObj(eventMap),
        claims: toObj(claimMap),
        relations: toObj(relationMap),
      },
      selection,
    };
  });

  return tx();
}

module.exports = { getRestorePreview, confirmRestore };
