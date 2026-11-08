import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { ARTICLES, MANUAL_CATEGORIES, searchArticles, articleToText, type ManualCategory, type Article } from '../lib/manualData';
import { manualArticleStore } from '../lib/manualNav';
import { settingsStore, openSection } from '../lib/state';
import { speak, stopSpeaking } from '../lib/speech';
import { sendToAssistant } from '../lib/assistant';

const URGENCY: Record<NonNullable<Article['urgency']>, { label: string; cls: string }> = {
  stop: { label: 'Остановитесь', cls: 'badge-danger' },
  soon: { label: 'Нужен сервис', cls: 'badge-warn' },
  info: { label: 'Справка', cls: 'badge-info' },
};

export function Manual() {
  const articleId = useStore(manualArticleStore);
  const settings = useStore(settingsStore);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<ManualCategory | 'all'>('all');

  const list = useMemo(() => {
    const found = query.trim() ? searchArticles(query) : ARTICLES;
    return cat === 'all' ? found : found.filter((a) => a.category === cat);
  }, [query, cat]);

  const article = articleId ? ARTICLES.find((a) => a.id === articleId) : null;

  if (article) {
    const u = article.urgency ? URGENCY[article.urgency] : null;
    return (
      <div className="section manual">
        <div className="article-bar">
          <button
            className="btn"
            onClick={() => {
              stopSpeaking();
              manualArticleStore.set(null);
            }}
          >
            <Icon name="back" /> Все статьи
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => speak(`${article.title}. ${articleToText(article)}`, settings.speechLang)}>
            <Icon name="speaker" /> Прочитать
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              openSection('assistant');
              void sendToAssistant(`Расскажи подробнее: ${article.title}`);
            }}
          >
            <Icon name="spark" /> Спросить AI
          </button>
        </div>
        <article className="article card">
          <div className="article-meta">
            <span className="eyebrow">{MANUAL_CATEGORIES[article.category]}</span>
            {u && <span className={`badge ${u.cls}`}>{u.label}</span>}
          </div>
          <h2 className="display">{article.title}</h2>
          <p className="lead">{article.summary}</p>
          {article.body.map((b, i) =>
            'h' in b ? (
              <h3 key={i}>{b.h}</h3>
            ) : 'p' in b ? (
              <p key={i}>{b.p}</p>
            ) : 'warn' in b ? (
              <div key={i} className="notice notice-danger">
                <Icon name="alert" size="1.6rem" />
                <p>{b.warn}</p>
              </div>
            ) : (
              <ul key={i}>
                {b.list.map((li) => (
                  <li key={li}>{li}</li>
                ))}
              </ul>
            ),
          )}
          <p className="muted small">Общая справка. Для вашей модели сверяйтесь с официальным руководством производителя.</p>
        </article>
      </div>
    );
  }

  return (
    <div className="section manual">
      <div className="search-row">
        <Icon name="search" size="1.6rem" />
        <input
          className="input input-xl input-bare"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск: «перегрев», «давление шин», «ABS»…"
          enterKeyHint="search"
        />
        {query && (
          <button className="icon-btn" onClick={() => setQuery('')} aria-label="Очистить">
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="chips chips-scroll">
        <button className={`chip ${cat === 'all' ? 'is-active' : ''}`} onClick={() => setCat('all')}>
          Все
        </button>
        {(Object.keys(MANUAL_CATEGORIES) as ManualCategory[]).map((c) => (
          <button key={c} className={`chip ${cat === c ? 'is-active' : ''}`} onClick={() => setCat(c)}>
            {MANUAL_CATEGORIES[c]}
          </button>
        ))}
      </div>
      <div className="article-list">
        {list.map((a) => {
          const u = a.urgency ? URGENCY[a.urgency] : null;
          return (
            <button key={a.id} className="article-row" onClick={() => manualArticleStore.set(a.id)}>
              <span className={`urgency-dot ${u?.cls ?? ''}`} />
              <span className="article-row-text">
                <strong>{a.title}</strong>
                <small>{a.summary}</small>
              </span>
              <Icon name="chevronRight" />
            </button>
          );
        })}
        {!list.length && (
          <div className="list-note">
            Во встроенном руководстве ничего не найдено.{' '}
            <button
              className="link-btn"
              onClick={() => {
                openSection('assistant');
                void sendToAssistant(query);
              }}
            >
              Спросить AI-помощника
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
