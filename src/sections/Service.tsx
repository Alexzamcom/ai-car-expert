import { useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import {
  serviceStore,
  settingsStore,
  upsertServiceRecord,
  deleteServiceRecord,
  nextServiceEstimate,
  SERVICE_CATEGORIES,
  toast,
  type ServiceRecord,
  type ServiceCategory,
} from '../lib/state';

type Draft = Omit<ServiceRecord, 'id'> & { id?: string };

const today = () => new Date().toISOString().slice(0, 10);
const emptyDraft = (): Draft => ({
  date: today(),
  odometerKm: settingsStore.get().vehicle.odometerKm,
  category: 'to',
  title: '',
  cost: null,
  workshop: '',
  notes: '',
});

const money = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';

export function Service() {
  const records = useStore(serviceStore);
  const settings = useStore(settingsStore);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const year = new Date().getFullYear();
  const yearCost = records.filter((r) => r.date.startsWith(String(year))).reduce((s, r) => s + (r.cost ?? 0), 0);
  const next = nextServiceEstimate(records, settings.vehicle);

  const save = () => {
    if (!draft) return;
    if (!draft.date) return toast('Укажите дату', 'warn');
    upsertServiceRecord({ ...draft, title: draft.title.trim() || SERVICE_CATEGORIES[draft.category] });
    setDraft(null);
    toast('Запись сохранена', 'ok');
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ app: 'ai-car-expert', version: 1, records }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ai-car-expert-service-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const importJson = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as { records?: ServiceRecord[] };
      const list = Array.isArray(data.records) ? data.records : [];
      const valid = list.filter((r) => r && typeof r.date === 'string' && r.category in SERVICE_CATEGORIES);
      valid.forEach((r) => upsertServiceRecord(r));
      toast(`Импортировано записей: ${valid.length}`, 'ok');
    } catch {
      toast('Не удалось прочитать файл', 'warn');
    }
  };

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const num = (v: string) => (v.trim() === '' ? null : Math.max(0, Number(v.replace(/\s/g, '').replace(',', '.')) || 0));

  return (
    <div className="section service">
      <div className="tiles tiles-3">
        <div className="tile">
          <div className="tile-label">Записей</div>
          <div className="tile-value">{records.length}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Расходы за {year}</div>
          <div className="tile-value">{money(yearCost)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Следующее ТО</div>
          <div className="tile-value tile-value-sm">
            {next ? `${next.dueDate.toLocaleDateString('ru-RU')}${next.dueKm != null ? ` · ${next.dueKm.toLocaleString('ru-RU')} км` : ''}` : '—'}
          </div>
        </div>
      </div>

      <div className="toolbar">
        <button className="btn btn-primary btn-lg" onClick={() => setDraft(emptyDraft())}>
          <Icon name="plus" /> Добавить запись
        </button>
        <span className="spacer" />
        <button className="btn" onClick={exportJson} disabled={!records.length}>
          <Icon name="download" /> Экспорт
        </button>
        <button className="btn" onClick={() => importRef.current?.click()}>
          <Icon name="upload" /> Импорт
        </button>
        <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
      </div>

      {draft && (
        <form
          className="card service-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="seg">
            {(Object.keys(SERVICE_CATEGORIES) as ServiceCategory[]).map((c) => (
              <button type="button" key={c} className={`chip ${draft.category === c ? 'is-active' : ''}`} onClick={() => set('category', c)}>
                {SERVICE_CATEGORIES[c]}
              </button>
            ))}
          </div>
          <div className="form-grid">
            <label className="field">
              <span>Дата</span>
              <input className="input" type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} />
            </label>
            <label className="field">
              <span>Пробег, км</span>
              <input className="input" inputMode="numeric" value={draft.odometerKm ?? ''} onChange={(e) => set('odometerKm', num(e.target.value))} />
            </label>
            <label className="field field-wide">
              <span>Что сделано</span>
              <input className="input" value={draft.title} placeholder={SERVICE_CATEGORIES[draft.category]} onChange={(e) => set('title', e.target.value)} />
            </label>
            <label className="field">
              <span>Стоимость, ₽</span>
              <input className="input" inputMode="decimal" value={draft.cost ?? ''} onChange={(e) => set('cost', num(e.target.value))} />
            </label>
            <label className="field">
              <span>Сервис</span>
              <input className="input" value={draft.workshop} onChange={(e) => set('workshop', e.target.value)} />
            </label>
            <label className="field field-wide">
              <span>Заметки</span>
              <textarea className="input" rows={2} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
            </label>
          </div>
          <div className="toolbar">
            <button type="submit" className="btn btn-primary btn-lg">
              <Icon name="check" /> Сохранить
            </button>
            <button type="button" className="btn btn-lg" onClick={() => setDraft(null)}>
              Отмена
            </button>
          </div>
        </form>
      )}

      <div className="record-list">
        {!records.length && !draft && (
          <div className="empty">
            <Icon name="wrench" size="3rem" />
            <p>История обслуживания пуста. Добавьте первую запись — например, последнее ТО.</p>
          </div>
        )}
        {records.map((r) => (
          <div key={r.id} className="record">
            <div className="record-date">
              <strong>{new Date(r.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</strong>
              <small>{r.date.slice(0, 4)}</small>
            </div>
            <div className="record-main">
              <div className="record-title">{r.title}</div>
              <div className="muted">
                {SERVICE_CATEGORIES[r.category]}
                {r.odometerKm != null && ` · ${r.odometerKm.toLocaleString('ru-RU')} км`}
                {r.workshop && ` · ${r.workshop}`}
              </div>
              {r.notes && <div className="record-notes">{r.notes}</div>}
            </div>
            {r.cost != null && <div className="record-cost">{money(r.cost)}</div>}
            <div className="record-actions">
              <button className="icon-btn" onClick={() => setDraft({ ...r })} aria-label="Изменить">
                <Icon name="edit" />
              </button>
              {confirmDelete === r.id ? (
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    deleteServiceRecord(r.id);
                    setConfirmDelete(null);
                  }}
                >
                  Удалить?
                </button>
              ) : (
                <button className="icon-btn" onClick={() => setConfirmDelete(r.id)} aria-label="Удалить">
                  <Icon name="trash" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
