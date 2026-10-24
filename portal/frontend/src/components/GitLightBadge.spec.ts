// 收工灯徽标的单测（issue #359 P0b）。
// 钉的是**界面侧的红线**（判色本身在 lib/gitLight.spec.ts）：
//   ① 颜色不是唯一语义通道 ⇒ 点旁边必须有文字，完整口径在 title 与 aria-label；
//   ② 红是日常态 ⇒ 不用 ⚠、不给告警底色、文案不说"错误/失败"；
//   ③ ⚪ 不得显绿（**包括旧后端把 partial 的绿漏过来时**）；
//   ④ 平台零 git 写 ⇒ 动作只预填（emit prefill），组件既不发请求也不碰发送。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import GitLightBadge from './GitLightBadge.vue';
import { i18n, setLocale } from '../i18n';
import type { GitLightPayload } from '../lib/gitLight';

const CJK = /[\u4e00-\u9fff]/;

function payloadOf(over: Partial<GitLightPayload> = {}): GitLightPayload {
  return {
    light: 'green', reason: 'synced', primary: null, cwd: '~/projects/p1',
    repos: [{
      rel: '', repo: 'p1', light: 'green', reason: 'synced', shell: false, branch: 'main',
      no_commits: false, tracked_count: 0, untracked_count: 0, truncated: false, push_state: 'synced',
    }],
    counts: { red: 0, yellow: 0, grey: 0, green: 1 }, partial: false, git_available: true,
    truncated_repos: 0, checked_at: '2026-10-24T08:00:00.000Z', ...over,
  };
}

function mountBadge(props: Record<string, unknown> = {}) {
  return mount(GitLightBadge, { props, global: { plugins: [i18n] } });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});

describe('颜色不承重：状态必须有文字，完整口径可达', () => {
  it('红：文字标签「未落地」渲染出来，title 与 aria-label 是同一句完整口径', async () => {
    const w = mountBadge({ payload: payloadOf({ light: 'red', reason: 'untracked' }) });
    expect(w.get('[data-test="git-light-label"]').text()).toBe('未落地');
    const title = w.get('[data-test="git-light-badge"]').attributes('title') ?? '';
    expect(title).toContain('未落地');
    expect(title).toContain('有文件还没纳入 git'); // 原因不能只靠颜色说
    expect(w.get('[data-test="git-light-badge"]').attributes('aria-label')).toBe(title);
  });

  it('点只是复述（aria-hidden），读屏与鼠标拿到的是同一句话', () => {
    const w = mountBadge({ payload: payloadOf({ light: 'yellow', reason: 'no_remote' }) });
    expect(w.get('[data-test="git-light-dot"]').attributes('aria-hidden')).toBe('true');
    expect(w.get('[data-test="git-light-label"]').text()).toBe('未推送');
  });

  it('红是日常态：界面任何一处都不出现 ⚠，文案也不说"错误/失败"', () => {
    const w = mountBadge({ payload: payloadOf({ light: 'red', reason: 'uncommitted' }) });
    const all = w.text() + (w.get('[data-test="git-light-badge"]').attributes('title') ?? '');
    expect(all).not.toContain('⚠');
    expect(all).not.toMatch(/错误|失败/);
  });

  it('四态在 zh / en 下都有文字标签，en 侧不掺汉字', async () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      setLocale(locale);
      for (const [light, reason] of [['red', 'uncommitted'], ['yellow', 'never_fetched'], ['green', 'synced'], ['grey', 'no_repo']] as const) {
        const w = mountBadge({ payload: payloadOf({ light, reason }) });
        const label = w.get('[data-test="git-light-label"]').text().trim();
        expect(label.length, `${locale}/${light}`).toBeGreaterThan(1);
        if (locale === 'en') expect(label, `${locale}/${light}`).not.toMatch(CJK);
        else expect(label, `${locale}/${light}`).toMatch(CJK);
      }
    }
    setLocale('zh-CN');
  });
});

describe('⚪ 不得显绿（含旧后端漏过来的绿）', () => {
  it('后端给了 green 但 partial=true ⇒ 界面不得出现「已收工」，得是「未检查」+ 未查完徽标', () => {
    const w = mountBadge({ payload: payloadOf({ light: 'green', reason: 'synced', partial: true }) });
    expect(w.text()).not.toContain('已收工');
    expect(w.get('[data-test="git-light-label"]').text()).toBe('未检查');
    expect(w.get('[data-test="git-light-partial"]').text()).toContain('未查完');
  });

  it('绿的 tooltip 必须说"与你已知的远端一致"，不许说成"远端是最新的"', () => {
    const w = mountBadge({ payload: payloadOf({ light: 'green', reason: 'synced' }) });
    const title = w.get('[data-test="git-light-badge"]').attributes('title') ?? '';
    expect(title).toContain('已知');
    expect(title).toContain('fetch');
    expect(title).not.toMatch(/远端是最新|远端最新/);
  });

  it('服务端没 git（现网旧镜像的形状）⇒ 灰 + 说清"服务端没有 git"', () => {
    const w = mountBadge({ payload: payloadOf({ light: 'grey', reason: 'git_unavailable', git_available: false }) });
    expect(w.get('[data-test="git-light-label"]').text()).toBe('未检查');
    expect(w.get('[data-test="git-light-badge"]').attributes('title')).toContain('没有 git');
  });
});

describe('动作：只预填，不发送（平台零 git 写）', () => {
  it('红/黄才有「让 AI 收尾」；绿/灰没有（没什么可收尾的）。**按钮在展开的面板里**，故先点开', async () => {
    const see = async (payload: GitLightPayload) => {
      const w = mountBadge({ payload });
      await w.get('[data-test="git-light-badge"]').trigger('click');
      return w.find('[data-test="git-light-finish"]').exists();
    };
    expect(await see(payloadOf({ light: 'red', reason: 'uncommitted' }))).toBe(true);
    expect(await see(payloadOf({ light: 'yellow', reason: 'no_remote' }))).toBe(true);
    expect(await see(payloadOf({ light: 'green' }))).toBe(false);
    expect(await see(payloadOf({ light: 'grey', reason: 'no_repo' }))).toBe(false);
    // 绿/灰没什么可收尾，但**万能兜底与重检不随状态消失**（用户任何时候都能问）
    const green = mountBadge({ payload: payloadOf({ light: 'green' }) });
    await green.get('[data-test="git-light-badge"]').trigger('click');
    expect(green.find('[data-test="git-light-ask"]').exists()).toBe(true);
    expect(green.find('[data-test="git-light-refresh"]').exists()).toBe(true);
  });

  it('点「让 AI 收尾」⇒ emit prefill，文本点名脏仓库、不掺 undefined，**不发任何请求**', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    const w = mountBadge({
      payload: payloadOf({
        light: 'red', reason: 'uncommitted',
        repos: [
          { rel: '', repo: 'p1', light: 'green', reason: 'synced', shell: false, branch: 'main', no_commits: false, tracked_count: 0, untracked_count: 0, truncated: false, push_state: 'synced' },
          { rel: 'svc', repo: 'svc', light: 'red', reason: 'uncommitted', shell: false, branch: 'main', no_commits: false, tracked_count: 3, untracked_count: 2, truncated: false, push_state: 'unknown' },
        ],
      }),
    });
    await w.get('[data-test="git-light-badge"]').trigger('click');
    await w.get('[data-test="git-light-finish"]').trigger('click');
    const emitted = w.emitted('prefill');
    expect(emitted).toHaveLength(1);
    const text = String(emitted![0][0]);
    expect(text).toContain('svc');          // 点名脏的那个
    expect(text).not.toContain('synced');   // 不点名已经收工的
    expect(text).not.toMatch(/undefined|\[object Object\]/);
    expect(fetchStub).not.toHaveBeenCalled(); // 组件自己一个请求都不发
    vi.unstubAllGlobals();
  });

  it('「问 AI」永远在（任何状态都能问），预填里带上状态与原因', async () => {
    const w = mountBadge({ payload: payloadOf({ light: 'grey', reason: 'no_repo' }), cwd: '~/projects/p1' });
    await w.get('[data-test="git-light-badge"]').trigger('click');
    await w.get('[data-test="git-light-ask"]').trigger('click');
    const text = String(w.emitted('prefill')![0][0]);
    expect(text).toContain('未检查');
    expect(text).toContain('p1');
    expect(text).not.toMatch(/undefined/);
  });

  it('「重新检查」⇒ emit refresh（刷新由调用方接 composable，组件不自己拉）', async () => {
    const w = mountBadge({ payload: payloadOf() });
    await w.get('[data-test="git-light-badge"]').trigger('click');
    await w.get('[data-test="git-light-refresh"]').trigger('click');
    expect(w.emitted('refresh')).toHaveLength(1);
  });

  it('预填不自动发送这条口径**写在界面上**（用户看得见"只是填进输入框"）', async () => {
    const w = mountBadge({ payload: payloadOf({ light: 'red', reason: 'uncommitted' }) });
    await w.get('[data-test="git-light-badge"]').trigger('click');
    expect(w.get('[data-test="git-light-finish-hint"]').text()).toContain('输入框');
  });
});

describe('面板与明细', () => {
  it('默认折叠：不展开就没有明细面板（顶栏只多一颗灯 + 一个词）', () => {
    const w = mountBadge({ payload: payloadOf() });
    expect(w.find('[data-test="git-light-panel"]').exists()).toBe(false);
  });

  it('展开后逐仓库点名，未跟踪数量说出来（用户要知道脏在哪）', async () => {
    const w = mountBadge({
      payload: payloadOf({
        light: 'red', reason: 'untracked',
        repos: [
          { rel: '', repo: 'p1', light: 'red', reason: 'untracked', shell: false, branch: 'main', no_commits: false, tracked_count: 0, untracked_count: 7, truncated: false, push_state: 'unknown' },
          { rel: 'web/app', repo: 'app', light: 'yellow', reason: 'never_fetched', shell: false, branch: 'main', no_commits: false, tracked_count: 0, untracked_count: 0, truncated: false, push_state: 'never_fetched' },
        ],
      }),
    });
    await w.get('[data-test="git-light-badge"]').trigger('click');
    const rows = w.findAll('[data-test="git-light-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[1].text()).toContain('web/app');
    expect(rows[0].attributes('title')).toContain('7');
  });

  it('请求失败时把码带进 tooltip（显示上一次结果，不装作一切正常）', () => {
    const w = mountBadge({
      payload: payloadOf({ light: 'red', reason: 'uncommitted' }),
      error: { status: 500, code: 'git_unavailable', message: 'boom' },
    });
    expect(w.get('[data-test="git-light-badge"]').attributes('title')).toContain('git_unavailable');
  });

  it('双语：en 下标签与 tooltip 都不掺汉字，且仍写着"only fills the composer"', async () => {
    setLocale('en');
    const w = mountBadge({ payload: payloadOf({ light: 'red', reason: 'uncommitted' }) });
    const label = w.get('[data-test="git-light-label"]').text();
    expect(label).not.toMatch(CJK);
    await w.get('[data-test="git-light-badge"]').trigger('click');
    const hint = w.get('[data-test="git-light-finish-hint"]').text();
    expect(hint).not.toMatch(CJK);
    expect(hint).toMatch(/does not send/i);
    setLocale('zh-CN');
  });

  it('payload 缺失（还没检查过）⇒ 显示未检查而不是崩', () => {
    const w = mountBadge({ payload: null });
    expect(w.get('[data-test="git-light-label"]').text()).toBe('未检查');
  });
});

// 源码级哨兵：模板里不许出现"提交/推送"动作按钮（平台零 git 写是 D9 的硬边界，加了就是违约）。
describe('平台零 git 写的源码锁', () => {
  it('模板里没有 commit/push/init 的中文动作词', async () => {
    const source = (await import('./GitLightBadge.vue?raw')).default;
    const template = source.slice(source.indexOf('<template'));
    expect(template).not.toMatch(/发起提交|立即提交|一键推送|自动提交/);
    expect(template).not.toMatch(/⚠/);
  });
});
