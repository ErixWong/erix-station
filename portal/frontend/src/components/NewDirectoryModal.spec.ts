import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import NewDirectoryModal from './NewDirectoryModal.vue';
import { i18n, setLocale } from '../i18n';
import { useWorkbenchStore } from '../stores/workbench';

function mountModal(onClose = vi.fn()) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(NewDirectoryModal, {
    global: { plugins: [pinia, i18n] },
    props: { onClose },
    attachTo: document.body,
  });
  return { wrapper, store: useWorkbenchStore(), onClose };
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('NewDirectoryModal · ModalShell integration', () => {
  it('open locks scrolling and focuses the name field; Esc closes and restores focus and prior scrolling', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    document.body.style.overflow = 'clip';
    const { wrapper, onClose } = mountModal();
    await flushPromises();

    const input = wrapper.get('#newDirName');
    expect(document.activeElement).toBe(input.element);
    expect(document.body.style.overflow).toBe('hidden');
    await input.trigger('keydown', { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe('clip');
  });

  it('backdrop click requests close; a failed create keeps the dialog open and shows the error', async () => {
    const { wrapper, store, onClose } = mountModal();
    vi.spyOn(store, 'createDir').mockResolvedValue({ error: 'directory already exists' });
    await flushPromises();

    await wrapper.get('[data-test="modal-backdrop"]').trigger('click');
    expect(onClose).toHaveBeenCalledTimes(1);
    await wrapper.get('#newDirName').setValue('existing-project');
    await wrapper.get('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').text()).toBe('directory already exists');
    wrapper.unmount();
  });
});
