import { useState } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { CarIllustration } from '../components/CarIllustration';
import { useStore } from '../lib/store';
import { settingsStore, serviceStore, vehicleName, nextServiceEstimate, openSection, toast, SERVICE_CATEGORIES } from '../lib/state';
import {
  allFacts,
  overridesStore,
  ownerFactsStore,
  confirmFact,
  resetFact,
  addOwnerFact,
  removeOwnerFact,
  STATUS_LABEL,
  TOPIC_LABEL,
  type KbTopic,
} from '../lib/knowledge';
import { MODULES } from '../lib/vehicle/types';
import { sendToAssistant } from '../lib/assistant';

const SYSTEMS: { icon: IconName; title: string }[] = [
  { icon: 'fan', title: 'Климат' },
  { icon: 'lock', title: 'Замки' },
  { icon: 'window', title: 'Окна' },
  { icon: 'light', title: 'Свет' },
];

const fmtKm = (n: number | null | undefined) => (n == null ? '—' : `${n.toLocaleString('ru-RU')} км`);

export function Vehicle() {
  const settings = useStore(settingsStore);
  const records = useStore(serviceStore);
  useStore(overridesStore);
  useStore(ownerFactsStore);
  const [topic, setTopic] = useState<KbTopic | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteText, setNoteText] = useState('');
  const v = settings.vehicle;
  const name = vehicleName(v);
  const next = nextServiceEstimate(records, v);
  const last = records[0];
  const facts = allFacts();
  const topics = [...new Set(facts.map((f) => f.topic))];
  const shown = topic === 'all' ? facts : facts.filter((f) => f.topic === topic);

  return (
    <div className="section vehicle">
      <div className="vehicle-hero card">
        <div className="vehicle-hero-text">
          <div className="eyebrow">Мой автомобиль</div>
          <h2 className="display">{name || 'Автомобиль не указан'}</h2>
          <div className="muted">{v.engine}</div>
          {v.vin && <div className="muted mono">VIN {v.vin}</div>}
          <button className="btn" onClick={() => openSection('settings')}>
            <Icon name="edit" /> Изменить профиль
          </button>
        </div>
        <CarIllustration />
      </div>

      <div className="tiles tiles-3">
        <div className="tile">
          <div className="tile-label">
            <Icon name="gauge" /> Пробег
          </div>
          <div className="tile-value">{fmtKm(v.odometerKm)}</div>
          <div className="tile-sub">{v.odometerDate ? `на ${new Date(v.odometerDate).toLocaleDateString('ru-RU')}` : 'вводится вручную'}</div>
        </div>
        <button className="tile tile-btn" onClick={() => openSection('service')}>
          <div className="tile-label">
            <Icon name="calendar" /> Следующее ТО
          </div>
          <div className={`tile-value tile-value-sm ${next && next.daysLeft < 0 ? 'text-danger' : ''}`}>{next ? next.dueDate.toLocaleDateString('ru-RU') : '—'}</div>
          <div className="tile-sub">{next ? (next.dueKm != null ? `или ${fmtKm(next.dueKm)}` : '') : 'нет записи о ТО'}</div>
        </button>
        <button className="tile tile-btn" onClick={() => openSection('service')}>
          <div className="tile-label">
            <Icon name="wrench" /> Последняя работа
          </div>
          <div className="tile-value tile-value-sm">{last ? last.title || SERVICE_CATEGORIES[last.category] : '—'}</div>
          <div className="tile-sub">{last ? new Date(last.date).toLocaleDateString('ru-RU') : 'записей нет'}</div>
        </button>
      </div>

      <h3 className="section-title">
        <Icon name="book" /> Что знает помощник о вашем автомобиле
      </h3>
      <p className="muted small">
        Подтверждайте факты, которые проверили по своему автомобилю или руководству, — помощник перестанет
        оговариваться. Неподтверждённые сведения он называет таковыми.
      </p>
      <div className="chips chips-scroll">
        <button className={`chip ${topic === 'all' ? 'is-active' : ''}`} onClick={() => setTopic('all')}>
          Все
        </button>
        {topics.map((t) => (
          <button key={t} className={`chip ${topic === t ? 'is-active' : ''}`} onClick={() => setTopic(t)}>
            {TOPIC_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="kb-list">
        {shown.map((f) => (
          <article key={f.id} className={`kb-fact status-${f.status}`}>
            <div className="kb-head">
              <strong>{f.title}</strong>
              <span className={`badge ${f.status === 'owner' || f.status === 'documented' ? 'badge-ok' : f.status === 'community' ? 'badge-warn' : 'badge-off'}`}>
                {STATUS_LABEL[f.status]}
              </span>
            </div>
            <p>{f.text}</p>
            {f.source && <small className="muted">Источник: {f.source}</small>}
            <div className="kb-actions">
              <button className="link-btn" onClick={() => { openSection('assistant'); void sendToAssistant(`Расскажи подробнее: ${f.title}`); }}>
                <Icon name="spark" size="1.1em" /> Спросить
              </button>
              {f.id.startsWith('own-') ? (
                <button className="link-btn" onClick={() => removeOwnerFact(f.id)}>
                  <Icon name="trash" size="1.1em" /> Удалить
                </button>
              ) : f.status !== 'owner' ? (
                <button className="link-btn" onClick={() => { confirmFact(f.id); toast('Отмечено как подтверждённое владельцем', 'ok'); }}>
                  <Icon name="check" size="1.1em" /> Подтверждаю для моего авто
                </button>
              ) : (
                <button className="link-btn" onClick={() => resetFact(f.id)}>
                  Снять подтверждение
                </button>
              )}
            </div>
          </article>
        ))}
        {!shown.length && <div className="list-note">Для этого автомобиля базы знаний пока нет. Добавьте свои заметки.</div>}
      </div>
      {adding ? (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!noteTitle.trim() || !noteText.trim()) return;
            addOwnerFact({ topic: 'controls', title: noteTitle.trim(), text: noteText.trim(), tags: noteTitle.toLowerCase().split(/\s+/) });
            setNoteTitle('');
            setNoteText('');
            setAdding(false);
          }}
        >
          <label className="field">
            <span>Что это (кнопка, функция, особенность)</span>
            <input id="kb-title" className="input" value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} placeholder="Например: кнопка под рулём слева" />
          </label>
          <label className="field">
            <span>Описание</span>
            <textarea id="kb-text" className="input" rows={3} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
          </label>
          <div className="toolbar">
            <button className="btn btn-primary btn-lg" type="submit">Сохранить</button>
            <button className="btn btn-lg" type="button" onClick={() => setAdding(false)}>Отмена</button>
          </div>
        </form>
      ) : (
        <button className="btn btn-lg" onClick={() => setAdding(true)}>
          <Icon name="plus" /> Добавить свою заметку
        </button>
      )}

      <h3 className="section-title">
        <Icon name="plug" /> Подключение к автомобилю
      </h3>
      <div className="systems">
        {SYSTEMS.map((s) => (
          <button key={s.title} className="system-tile" aria-disabled="true" onClick={() => toast(`${s.title}: управление недоступно — нет интеграции с автомобилем.`, 'warn')}>
            <Icon name={s.icon} size="2rem" />
            <span className="system-name">{s.title}</span>
            <span className="badge badge-off">
              <Icon name="lock" size="0.9em" /> Нет интеграции
            </span>
          </button>
        ))}
      </div>
      <div className="module-list">
        {MODULES.map((m) => (
          <div key={m.id} className="module-row">
            <Icon name={m.kind === 'security' ? 'shield' : 'obd'} size="1.6rem" />
            <div>
              <strong>{m.name}</strong>
              <small>{m.note}</small>
            </div>
            <span className="badge badge-off">{m.status === 'planned' ? 'Запланировано' : m.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
