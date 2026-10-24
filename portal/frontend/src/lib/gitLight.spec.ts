// 收工灯纯函数层的单测（issue #359 / 决策 §7 D9，P0b）。
// 承重的三条红线都在这里钉：①⚪ 不得显绿 ②不认识的值不猜 ③脏值不渗进文案。
import { describe, expect, it } from 'vitest';
import {
  checkedAgo,
  dirtyRepoNames,
  gitLightDisplay,
  gitLightPath,
  gitLightReasonKey,
  parseGitLightPayload,
  toGitLightApiError,
  type GitLightPayload,
} from './gitLight';

function payloadOf(over: Partial<GitLightPayload> = {}): GitLightPayload {
  return {
    light: 'green',
    reason: 'synced',
    primary: null,
    cwd: '~/projects/p1',
    repos: [],
    counts: { red: 0, yellow: 0, grey: 0, green: 1 },
    partial: false,
    git_available: true,
    truncated_repos: 0,
    checked_at: '2026-10-24T08:00:00.000Z',
    ...over,
  };
}

function rowOf(over: Record<string, unknown> = {}) {
  return {
    rel: 'sub', repo: 'sub', light: 'red', reason: 'uncommitted', shell: false, branch: 'main',
    no_commits: false, tracked_count: 1, untracked_count: 0, truncated: false, push_state: 'unknown',
    ...over,
  };
}

describe('端点路径与错误收纳', () => {
  it('cwd 一律 URL 编码（路径里带空格/中文/波浪号都不许截断请求）', () => {
    expect(gitLightPath('~/projects/我的 项目')).toBe('/api/git-light?cwd=' + encodeURIComponent('~/projects/我的 项目'));
  });

  it('ApiError 有码取码；没有码退 "unknown"，**不许渗 undefined 字面量**', () => {
    const err = Object.assign(new Error('nope'), { status: 500, code: 'git_unavailable' });
    expect(toGitLightApiError(err)).toEqual({ status: 500, code: 'git_unavailable', message: 'nope' });
    const bare = toGitLightApiError(new Error('boom'));
    expect(bare.code).toBe('unknown');
    expect(bare.status).toBe(0);
    expect(JSON.stringify(bare)).not.toContain('undefined');
  });
});

describe('脏载荷消毒（拿值判形状，不 as 一把梭）', () => {
  it('正常载荷原样收下并保留字段', () => {
    const p = parseGitLightPayload({
      light: 'red', reason: 'untracked', cwd: '~/projects/p1', git_available: true, partial: false,
      checked_at: '2026-10-24T08:00:00.000Z', counts: { red: 1, yellow: 0, grey: 0, green: 0 },
      truncated_repos: 0, repos: [rowOf()],
    });
    expect(p?.light).toBe('red');
    expect(p?.repos[0].repo).toBe('sub');
  });

  it.each([
    ['不是对象', null],
    ['数组', []],
    ['light 缺失', { repos: [] }],
    ['light 是不认识的颜色', { light: 'purple', repos: [] }],
    ['light 不是字符串', { light: 3, repos: [] }],
    ['repos 不是数组', { light: 'red', repos: {} }],
  ])('%s ⇒ null（调用方显示"未检查"，绝不因为不认识就显绿）', (_name, raw) => {
    expect(parseGitLightPayload(raw)).toBeNull();
  });

  it('行内脏值逐个消毒：脏数字退 0、脏 light 退 grey、缺 reason 退 unknown', () => {
    const p = parseGitLightPayload({
      light: 'red', reason: 'uncommitted', repos: [{ rel: 'a', repo: 'a', light: '??', reason: null, tracked_count: 'x', untracked_count: undefined }],
    });
    const row = p?.repos[0];
    expect(row?.light).toBe('grey');
    expect(row?.reason).toBe('unknown');
    expect(row?.tracked_count).toBe(0);
    expect(row?.untracked_count).toBe(0);
    expect(row?.push_state).toBe('unknown');
    expect(row?.branch).toBeNull();
  });
});

describe('显示口径：⚪ 不得显绿', () => {
  it('没数据（未请求 / 脏载荷 / 请求失败）⇒ grey + unknown，不是绿', () => {
    expect(gitLightDisplay(null)).toEqual({ state: 'grey', reasonKey: 'gitLight.reason.unknown', needsAction: false });
  });

  it.each([
    ['red', 'uncommitted', 'red', true],
    ['yellow', 'no_remote', 'yellow', true],
    ['green', 'synced', 'green', false],
    ['grey', 'no_repo', 'grey', false],
  ])('%s ⇒ %s（needsAction=%s）', (light, reason, state, action) => {
    const d = gitLightDisplay(payloadOf({ light, reason }));
    expect(d.state).toBe(state);
    expect(d.needsAction).toBe(action);
  });

  it('**绿 + partial ⇒ 落灰**（后端已兜一层，这层防旧后端与未来回归：没检查完就没资格承诺）', () => {
    const d = gitLightDisplay(payloadOf({ light: 'green', reason: 'synced', partial: true }));
    expect(d.state).toBe('grey');
    expect(d.needsAction).toBe(false);
  });

  it('服务端给不认识的颜色 ⇒ grey（不落到绿的分支）', () => {
    expect(gitLightDisplay(payloadOf({ light: 'magenta' })).state).toBe('grey');
  });

  it('reason 不在表上 ⇒ 走 reason.unknown 文案，不拼出没这个键的 i18n key', () => {
    expect(gitLightReasonKey('made_up_reason')).toBe('gitLight.reason.unknown');
    expect(gitLightReasonKey('never_fetched')).toBe('gitLight.reason.never_fetched');
    const d = gitLightDisplay(payloadOf({ light: 'yellow', reason: 'made_up_reason' }));
    expect(d.reasonKey).toBe('gitLight.reason.unknown');
  });
});

describe('「让 AI 收尾」点名谁（预填要给 AI 指名目标）', () => {
  it('只点脏的（红/黄），绿的不出现在预填里', () => {
    const p = parseGitLightPayload(payloadOf({
      light: 'red',
      repos: [rowOf({ rel: 'dirty-one', light: 'red' }), rowOf({ rel: 'clean-two', light: 'green', reason: 'synced' }), rowOf({ rel: 'unpushed-three', light: 'yellow', reason: 'never_fetched' })],
    }));
    expect(dirtyRepoNames(p)).toEqual({ names: ['dirty-one', 'unpushed-three'], more: 0 });
  });

  it('空壳外壳不点名（它恒为红，会把真仓库挤掉）', () => {
    const p = parseGitLightPayload(payloadOf({ repos: [rowOf({ rel: '', repo: 'p1', light: 'red', reason: 'shell', shell: true })] }));
    expect(dirtyRepoNames(p).names).toEqual([]);
  });

  it('超过上限不静默截断：more 报数，文案能说"还有 N 个"', () => {
    const rows = Array.from({ length: 9 }, (_, i) => rowOf({ rel: `r${i}`, light: 'red' }));
    const p = parseGitLightPayload(payloadOf({ repos: rows }));
    const got = dirtyRepoNames(p, 6);
    expect(got.names).toHaveLength(6);
    expect(got.more).toBe(3);
  });

  it('null ⇒ 空列表（不抛）', () => {
    expect(dirtyRepoNames(null)).toEqual({ names: [], more: 0 });
  });
});

describe('检查时间（tooltip 里的"检查于 Xs 前"）', () => {
  const now = Date.parse('2026-10-24T08:00:00.000Z');
  it('秒 / 分 / 时三档', () => {
    expect(checkedAgo('2026-10-24T07:59:47.000Z', now)).toBe('13s');
    expect(checkedAgo('2026-10-24T07:58:00.000Z', now)).toBe('2m');
    expect(checkedAgo('2026-10-24T06:00:00.000Z', now)).toBe('2h');
  });
  it('脏时间戳 ⇒ null（宁可不说，不说 undefined）；未来时间不出现负数', () => {
    expect(checkedAgo('', now)).toBeNull();
    expect(checkedAgo('not-a-date', now)).toBeNull();
    expect(checkedAgo('2026-10-24T09:00:00.000Z', now)).toBe('0s');
  });
});
