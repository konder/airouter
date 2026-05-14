import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('TUI Form State Management', () => {
  type FormMode = 'add' | 'edit';
  interface FormField { key: string; label: string; value: string; hint?: string }
  interface FormState {
    mode: FormMode;
    editName: string;
    fields: FormField[];
    activeField: number;
    editing: boolean;
  }

  let form: FormState;

  function initAddForm() {
    form = {
      mode: 'add',
      editName: '',
      activeField: 0,
      editing: false,
      fields: [
        { key: 'name', label: 'Name', value: '' },
        { key: 'type', label: 'Type', value: 'openai', hint: 'openai / anthropic' },
        { key: 'baseurl', label: 'Base URL', value: '' },
        { key: 'key', label: 'API Key', value: '' },
        { key: 'weight', label: 'Weight', value: '1' },
      ],
    };
  }

  function initEditForm(upstream: any) {
    form = {
      mode: 'edit',
      editName: upstream.name,
      activeField: 0,
      editing: false,
      fields: [
        { key: 'type', label: 'Type', value: upstream.type },
        { key: 'baseurl', label: 'Base URL', value: upstream.baseurl },
        { key: 'key', label: 'API Key', value: '' },
        { key: 'weight', label: 'Weight', value: String(upstream.weight) },
      ],
    };
  }

  function navigate(dir: number) {
    if (form.editing) return;
    const max = form.fields.length;
    form.activeField = Math.max(0, Math.min(max, form.activeField + dir));
  }

  function validate(): string | null {
    if (form.mode === 'add') {
      const vals: Record<string, string> = {};
      for (const f of form.fields) vals[f.key] = f.value;
      if (!vals.name) return 'Name required';
      if (!vals.baseurl) return 'Base URL required';
      if (!vals.key) return 'API Key required';
      if (vals.type !== 'openai' && vals.type !== 'anthropic') return 'Invalid type';
    }
    return null;
  }

  beforeEach(() => {
    initAddForm();
  });

  it('should initialize add form with 5 fields', () => {
    expect(form.fields).toHaveLength(5);
    expect(form.mode).toBe('add');
    expect(form.activeField).toBe(0);
  });

  it('should initialize edit form with 4 fields (no name)', () => {
    initEditForm({ name: 'test', type: 'openai', baseurl: 'http://x', weight: 2 });
    expect(form.fields).toHaveLength(4);
    expect(form.mode).toBe('edit');
    expect(form.editName).toBe('test');
    expect(form.fields[0].value).toBe('openai');
  });

  it('should navigate between fields', () => {
    expect(form.activeField).toBe(0);
    navigate(1);
    expect(form.activeField).toBe(1);
    navigate(1);
    expect(form.activeField).toBe(2);
    navigate(-1);
    expect(form.activeField).toBe(1);
  });

  it('should clamp navigation at boundaries', () => {
    navigate(-1);
    expect(form.activeField).toBe(0);
    // Navigate to submit button (index = fields.length)
    for (let i = 0; i < 10; i++) navigate(1);
    expect(form.activeField).toBe(form.fields.length);
  });

  it('should not navigate while editing', () => {
    form.editing = true;
    navigate(1);
    expect(form.activeField).toBe(0);
  });

  it('should validate required fields for add mode', () => {
    expect(validate()).toBe('Name required');

    form.fields[0].value = 'test';
    expect(validate()).toBe('Base URL required');

    form.fields[2].value = 'http://x';
    expect(validate()).toBe('API Key required');

    form.fields[3].value = 'sk-123';
    expect(validate()).toBeNull();
  });

  it('should reject invalid type', () => {
    form.fields[0].value = 'test';
    form.fields[1].value = 'invalid';
    form.fields[2].value = 'http://x';
    form.fields[3].value = 'sk-123';
    expect(validate()).toBe('Invalid type');
  });

  it('should accept anthropic type', () => {
    form.fields[0].value = 'test';
    form.fields[1].value = 'anthropic';
    form.fields[2].value = 'http://x';
    form.fields[3].value = 'sk-123';
    expect(validate()).toBeNull();
  });

  it('edit form should leave key empty by default', () => {
    initEditForm({ name: 'test', type: 'openai', baseurl: 'http://x', weight: 1 });
    const keyField = form.fields.find(f => f.key === 'key');
    expect(keyField?.value).toBe('');
  });

  it('activeField at fields.length means submit button', () => {
    form.activeField = form.fields.length;
    expect(form.activeField).toBe(5);
  });
});
