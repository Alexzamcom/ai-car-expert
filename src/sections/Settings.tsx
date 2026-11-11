import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { settingsStore, toast, type Settings as SettingsT, type VehicleProfile, type AiProvider } from '../lib/state';
import { usageStore, currentUsage, fmtUsd, resetUsage, PROVIDER_LABEL } from '../lib/ai/usage';
import { wakeLockSupported } from '../lib/wakeLock';
import { speechRecognitionSupported, listVoices, speak } from '../lib/speech';
import { chatgptPrefsStore } from '../lib/chatgpt';
import { themeStore, setThemeMode, THEME_MODE_LABEL, type ThemeMode } from '../lib/theme';
import { MUSIC_SOURCES } from '../lib/music/sources';

const FUELS: Record<VehicleProfile['fuel'], string> = {
  petrol: 'Бензин',
  diesel: 'Дизель',
  hybrid: 'Гибрид',
  electric: 'Электро',
  gas: 'Газ',
};

const SCALES: Record<SettingsT['textScale'], string> = { normal: 'Обычный', large: 'Крупный', xlarge: 'Очень крупный' };

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function Settings() {
  const s = useStore(settingsStore);
  const [v, setV] = useState<VehicleProfile>(s.vehicle);
  const [voices, setVoices] = useState(() => listVoices(s.speechLang));
  useEffect(() => {
    const update = () => setVoices(listVoices(s.speechLang));
    update();
    window.speechSynthesis?.addEventListener?.('voiceschanged', update);
    return () => window.speechSynthesis?.removeEventListener?.('voiceschanged', update);
  }, [s.speechLang]);

  const patch = (p: Partial<SettingsT>) => settingsStore.set((x) => ({ ...x, ...p }));
  const num = (val: string) => (val.trim() === '' ? null : Math.max(0, parseInt(val.replace(/\D/g, ''), 10) || 0));

  return (
    <div className="section settings">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          patch({
            vehicle: {
              ...v,
              vin: v.vin.toUpperCase().trim(),
              odometerDate: v.odometerKm !== s.vehicle.odometerKm ? new Date().toISOString().slice(0, 10) : v.odometerDate,
            },
          });
          toast('Профиль автомобиля сохранён', 'ok');
        }}
      >
        <h3 className="section-title">
          <Icon name="car" /> Автомобиль
        </h3>
        <div className="form-grid">
          <label className="field">
            <span>Марка</span>
            <input className="input" value={v.make} onChange={(e) => setV({ ...v, make: e.target.value })} placeholder="Например, Toyota" />
          </label>
          <label className="field">
            <span>Модель</span>
            <input className="input" value={v.model} onChange={(e) => setV({ ...v, model: e.target.value })} placeholder="Camry" />
          </label>
          <label className="field">
            <span>Год</span>
            <input className="input" inputMode="numeric" maxLength={4} value={v.year} onChange={(e) => setV({ ...v, year: e.target.value.replace(/\D/g, '') })} />
          </label>
          <label className="field">
            <span>Пробег, км</span>
            <input className="input" inputMode="numeric" value={v.odometerKm ?? ''} onChange={(e) => setV({ ...v, odometerKm: num(e.target.value) })} />
          </label>
          <label className="field field-wide">
            <span>Двигатель</span>
            <input id="vehicle-engine" className="input" value={v.engine} onChange={(e) => setV({ ...v, engine: e.target.value })} placeholder="1.6 THP (бензин, турбо)" />
          </label>
          <label className="field field-wide">
            <span>VIN (необязательно)</span>
            <input className="input mono" maxLength={17} value={v.vin} onChange={(e) => setV({ ...v, vin: e.target.value })} autoCapitalize="characters" />
          </label>
          <div className="field field-wide">
            <span>Топливо</span>
            <div className="seg">
              {(Object.keys(FUELS) as VehicleProfile['fuel'][]).map((f) => (
                <button type="button" key={f} className={`chip ${v.fuel === f ? 'is-active' : ''}`} onClick={() => setV({ ...v, fuel: f })}>
                  {FUELS[f]}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Интервал ТО, км</span>
            <input className="input" inputMode="numeric" value={v.serviceIntervalKm} onChange={(e) => setV({ ...v, serviceIntervalKm: num(e.target.value) ?? 0 })} />
          </label>
          <label className="field">
            <span>Интервал ТО, мес.</span>
            <input className="input" inputMode="numeric" value={v.serviceIntervalMonths} onChange={(e) => setV({ ...v, serviceIntervalMonths: num(e.target.value) ?? 0 })} />
          </label>
        </div>
        <button className="btn btn-primary btn-lg" type="submit">
          <Icon name="check" /> Сохранить
        </button>
      </form>

      <AiSettings />

      <ThemeSettings />

      <MusicSettings />

      <ChatGptSettings />

      <div className="card">
        <h3 className="section-title">
          <Icon name="mic" /> Голос и экран
        </h3>
        <div className="setting-row">
          <div>
            <strong>Язык речи</strong>
            <small>{speechRecognitionSupported() ? 'Распознавание речи доступно' : 'Распознавание недоступно — используйте диктовку клавиатуры'}</small>
          </div>
          <div className="seg">
            {[
              ['ru-RU', 'Русский'],
              ['uk-UA', 'Українська'],
              ['en-US', 'English'],
            ].map(([code, label]) => (
              <button key={code} className={`chip ${s.speechLang === code ? 'is-active' : ''}`} onClick={() => patch({ speechLang: code, voiceURI: '' })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Голос</strong>
            <small>{voices.length ? 'Голоса устройства для выбранного языка' : 'Для этого языка на устройстве нет голоса — установите его в настройках iPad: Универсальный доступ → Устный контент → Голоса'}</small>
          </div>
          <div className="seg">
            <select id="voice-select" className="input select" value={s.voiceURI} onChange={(e) => patch({ voiceURI: e.target.value })} disabled={!voices.length}>
              <option value="">Автоматически</option>
              {voices.map((vo) => (
                <option key={vo.voiceURI} value={vo.voiceURI}>
                  {vo.name}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => speak(SAMPLE[s.speechLang.slice(0, 2)] ?? SAMPLE.ru, s.speechLang)}>
              <Icon name="speaker" /> Проба
            </button>
          </div>
        </div>
        <ToggleRow title="Голосовые ответы помощника" sub="Ответы помощника и результаты команд читаются вслух" on={s.speakReplies} onChange={(on) => patch({ speakReplies: on })} />
        <ToggleRow title="Голосовые подсказки навигации" sub="«Через 200 метров поверните направо»" on={s.speakNavigation} onChange={(on) => patch({ speakNavigation: on })} />
        <ToggleRow title="Режим разговора" sub="После голосового ответа помощник снова слушает — без нажатия кнопки" on={s.conversationMode} onChange={(on) => patch({ conversationMode: on })} />
        <ToggleRow title="Подсказки о функциях автомобиля" sub="Короткий совет дня на панели «Поездка»" on={s.featureTips} onChange={(on) => patch({ featureTips: on })} />
        <div className="setting-row">
          <div>
            <strong>Размер текста</strong>
            <small>Для чтения на расстоянии</small>
          </div>
          <div className="seg">
            {(Object.keys(SCALES) as SettingsT['textScale'][]).map((k) => (
              <button key={k} className={`chip ${s.textScale === k ? 'is-active' : ''}`} onClick={() => patch({ textScale: k })}>
                {SCALES[k]}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Не выключать экран</strong>
            <small>{wakeLockSupported() ? 'Пока приложение открыто' : 'Не поддерживается — отключите автоблокировку в настройках iPad'}</small>
          </div>
          <Toggle on={s.keepAwake} onChange={(on) => patch({ keepAwake: on })} label="Не выключать экран" />
        </div>
      </div>

      <div className="card">
        <h3 className="section-title">
          <Icon name="home" /> Установка на iPad
        </h3>
        {isStandalone() ? (
          <p className="text-ok">
            <Icon name="check" /> Приложение запущено в полноэкранном режиме.
          </p>
        ) : (
          <ol className="steps">
            <li>Откройте приложение в Safari.</li>
            <li>Нажмите «Поделиться» → «На экран „Домой“».</li>
            <li>Запускайте AI Car Expert с экрана «Домой» — он откроется во весь экран.</li>
            <li>Для автомобиля: Настройки → Экран и яркость → Автоблокировка → «Никогда»; при желании — «Гид-доступ».</li>
            <li>Автозапуск при подключении к Bluetooth автомобиля — см. раздел «Автомобильный режим» в README.</li>
          </ol>
        )}
      </div>

      <div className="card">
        <h3 className="section-title">
          <Icon name="alert" /> Данные
        </h3>
        <p className="muted">Все данные хранятся только на этом iPad.</p>
        <ResetButton />
        <p className="muted small">AI Car Expert · версия {__APP_VERSION__}</p>
      </div>
    </div>
  );
}

function MusicSettings() {
  const s = useStore(settingsStore);
  const patch = (p: Partial<SettingsT>) => settingsStore.set((x) => ({ ...x, ...p }));
  return (
    <div className="card">
      <h3 className="section-title">
        <Icon name="music" /> Музыка
      </h3>
      <div className="setting-row">
        <div>
          <strong>Предпочитаемый сервис</strong>
          <small>Для команды «Включи музыку» и раздела «Музыка»</small>
        </div>
        <div className="seg" role="radiogroup" aria-label="Предпочитаемый музыкальный сервис">
          {MUSIC_SOURCES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={s.preferredMusic === m.id}
              disabled={m.kind === 'planned'}
              className={`chip ${s.preferredMusic === m.id ? 'is-active' : ''}`}
              onClick={() => m.kind !== 'planned' && patch({ preferredMusic: m.id as 'radio' | 'youtube-music' })}
            >
              {m.id === 'radio' ? 'Радио' : m.name}
              {m.kind === 'planned' ? ' · скоро' : ''}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>YouTube Music на iPad и iPhone</strong>
          <small>Сначала пробовать приложение; если оно не открылось — предложить сайт music.youtube.com</small>
        </div>
        <div className="seg" role="radiogroup" aria-label="Как открывать YouTube Music">
          {(
            [
              ['app', 'Приложение'],
              ['browser', 'Сразу сайт'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} role="radio" aria-checked={s.ytmOpenMode === v} className={`chip ${s.ytmOpenMode === v ? 'is-active' : ''}`} onClick={() => patch({ ytmOpenMode: v })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">
        YouTube Music открывается как отдельное приложение с вашей учётной записью: без API-ключей и без встраивания.
        Управлять его воспроизведением и выбирать треки голосом AI Car Expert не может. При переходе интернет-радио ставится на паузу.
      </p>
    </div>
  );
}

function ThemeSettings() {
  const t = useStore(themeStore);
  const time = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const status =
    t.reason === 'manual'
      ? `Включена ${t.active === 'day' ? 'дневная' : 'ночная'} тема.`
      : t.reason === 'sun'
        ? `Сейчас ${t.active === 'day' ? 'день' : 'ночь'} по положению солнца.${t.next ? ` ${t.next.to === 'night' ? 'Закат' : 'Восход'} в ${time(t.next.at)} — тема сменится сама.` : ' Полярный день или ночь.'}`
        : `Координат пока нет — тема как в системе устройства (${t.active === 'day' ? 'светлая' : 'тёмная'}). После определения геопозиции — по восходу и закату.`;
  return (
    <div className="card">
      <h3 className="section-title">
        <Icon name="sun" /> Оформление
      </h3>
      <div className="seg theme-seg" role="radiogroup" aria-label="Тема оформления">
        {(['auto', 'day', 'night'] as ThemeMode[]).map((m) => (
          <button key={m} role="radio" aria-checked={t.mode === m} className={`chip ${t.mode === m ? 'is-active' : ''}`} onClick={() => setThemeMode(m)}>
            <Icon name={m === 'auto' ? 'autoTheme' : m === 'day' ? 'sun' : 'moon'} /> {THEME_MODE_LABEL[m]}
          </button>
        ))}
      </div>
      <p className="muted" id="theme-status">
        {status}
      </p>
      <p className="muted small">Быстрое переключение — кнопка с солнцем или луной в верхней строке. Выбор сохраняется.</p>
    </div>
  );
}

function ChatGptSettings() {
  const prefs = useStore(chatgptPrefsStore);
  const [name, setName] = useState(prefs.voiceShortcut);
  return (
    <div className="card">
      <h3 className="section-title">
        <Icon name="chat" /> ChatGPT по подписке
      </h3>
      <p className="muted">
        Кнопка ChatGPT в нижней панели открывает приложение ChatGPT (или сайт chatgpt.com) с вашей подпиской.
        API и платные сервисы не используются. Голосовой режим включается в самом ChatGPT.
      </p>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          chatgptPrefsStore.set((p) => ({ ...p, voiceShortcut: name.trim() }));
          toast(name.trim() ? 'Быстрая команда сохранена' : 'Кнопка голосового режима скрыта', 'ok');
        }}
      >
        <label className="field field-wide">
          <span>Быстрая команда для голосового режима (необязательно, iPad/iPhone)</span>
          <input id="chatgpt-shortcut" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: ChatGPT голос" />
        </label>
        <p className="muted small field-wide">
          В приложении «Команды» создайте команду с действием ChatGPT для голосового разговора (если оно есть в вашей
          версии приложения ChatGPT) и впишите её имя. Тогда рядом с кнопкой «Открыть ChatGPT» появится «Голосовой режим».
        </p>
        <div className="toolbar field-wide">
          <button className="btn btn-primary" type="submit">
            <Icon name="check" /> Сохранить
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              chatgptPrefsStore.set((p) => ({ ...p, hintSeen: false }));
              toast('Подсказка «как вернуться» снова будет показана', 'ok');
            }}
          >
            Показывать подсказку о возврате
          </button>
        </div>
      </form>
    </div>
  );
}

const SAMPLE: Record<string, string> = {
  ru: 'Через двести метров поверните направо.',
  uk: 'Через двісті метрів поверніть праворуч.',
  en: 'In two hundred meters, turn right.',
};

/** Проверка прокси: доступность, какие провайдеры настроены (ключи — только на сервере). */
export async function checkProxy(endpoint: string, provider: AiProvider) {
  try {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/(chat)?$/, '') + '/health';
    const res = await fetch(url.toString());
    const data = (await res.json()) as { ok?: boolean; model?: string; keyConfigured?: boolean; providers?: Record<string, { configured: boolean; model: string }> };
    if (!data.ok) return toast('Прокси ответил неожиданно', 'warn');
    const p = data.providers?.[provider];
    if (p?.configured) toast(`Прокси отвечает. ${PROVIDER_LABEL[provider]}: модель ${p.model}`, 'ok');
    else if (p) toast(`Прокси отвечает, но ключ ${PROVIDER_LABEL[provider]} на сервере не задан`, 'warn');
    else if (data.keyConfigured) toast(`Прокси старой версии (только Grok, модель ${data.model}). Обновите server/ai-proxy для OpenAI.`, 'warn');
    else toast('Прокси отвечает, но ключ на сервере не задан', 'warn');
  } catch {
    toast('Прокси недоступен: проверьте адрес и разрешённые источники (ALLOWED_ORIGINS)', 'warn');
  }
}

function AiSettings() {
  const s = useStore(settingsStore);
  const u = useStore(usageStore);
  void u;
  const usage = currentUsage();
  const [endpoint, setEndpoint] = useState(s.aiEndpoint);
  const [token, setToken] = useState(s.aiToken);
  const patch = (p: Partial<SettingsT>) => settingsStore.set((x) => ({ ...x, ...p }));
  const price = s.aiPrices[s.aiProvider];
  const setPrice = (k: 'inUsd' | 'outUsd', val: string) => {
    const n = Math.max(0, Number(val.replace(',', '.')) || 0);
    patch({ aiPrices: { ...s.aiPrices, [s.aiProvider]: { ...price, [k]: n } } });
  };
  const intVal = (val: string) => Math.max(0, parseInt(val.replace(/\D/g, ''), 10) || 0);
  return (
    <form
      className="card ai-settings"
      onSubmit={(e) => {
        e.preventDefault();
        const url = endpoint.trim();
        if (url && !/^https:\/\//.test(url) && !/^http:\/\/localhost/.test(url)) {
          toast('Адрес прокси должен начинаться с https://', 'warn');
          return;
        }
        patch({ aiEndpoint: url, aiToken: token.trim() });
        toast(url ? 'Подключение ИИ сохранено' : 'Облачный ИИ отключён — работают команды и встроенная база', 'ok');
      }}
    >
      <h3 className="section-title">
        <Icon name="spark" /> ИИ-помощник
      </h3>
      <p className="muted">
        Простые команды (маршрут, остановка, радио, разделы, тема, коды ошибок, срок ТО) выполняются на устройстве бесплатно.
        Сложные вопросы уходят выбранному провайдеру через ваш сервер-прокси (код — server/ai-proxy). Ключи OpenAI и xAI
        хранятся только в секретах сервера; здесь — адрес прокси и токен доступа к нему, это не ключ API. Подписки ChatGPT Plus и
        Grok не дают доступа к API: API оплачивается отдельно.
      </p>

      <div className="setting-row">
        <div>
          <strong>Провайдер</strong>
          <small>Grok — альтернатива; на сервере должен быть задан ключ выбранного провайдера</small>
        </div>
        <div className="seg" role="radiogroup" aria-label="Провайдер ИИ">
          {(['openai', 'grok'] as AiProvider[]).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={s.aiProvider === p} className={`chip ${s.aiProvider === p ? 'is-active' : ''}`} onClick={() => patch({ aiProvider: p })}>
              {PROVIDER_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>Режим</strong>
          <small>{s.aiMode === 'local' ? 'Платный API не используется совсем' : 'Простое — на устройстве, сложное — в облаке'}</small>
        </div>
        <div className="seg" role="radiogroup" aria-label="Режим ИИ">
          {(
            [
              ['hybrid', 'Гибридный'],
              ['local', 'Только на устройстве'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={s.aiMode === m} className={`chip ${s.aiMode === m ? 'is-active' : ''}`} onClick={() => patch({ aiMode: m })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="form-grid">
        <label className="field field-wide">
          <span>Адрес прокси</span>
          <input id="ai-endpoint" className="input" inputMode="url" placeholder="https://ai-car-expert-ai.<аккаунт>.workers.dev/chat" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} autoComplete="off" />
        </label>
        <label className="field field-wide">
          <span>Токен доступа к прокси (хранится только на этом устройстве)</span>
          <input id="ai-token" className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </label>
      </div>
      <div className="toolbar">
        <button className="btn btn-primary btn-lg" type="submit">
          <Icon name="check" /> Сохранить
        </button>
        <button className="btn btn-lg" type="button" disabled={!endpoint.trim()} onClick={() => void checkProxy(endpoint.trim(), s.aiProvider)}>
          <Icon name="wifi" /> Проверить связь
        </button>
      </div>

      <h4 className="subsection">Расходы и ограничения</h4>
      <div className="form-grid">
        <label className="field">
          <span>Запросов к ИИ в сутки (0 — без предела)</span>
          <input id="ai-daily-limit" className="input" inputMode="numeric" value={s.aiDailyLimit} onChange={(e) => patch({ aiDailyLimit: intVal(e.target.value) })} />
        </label>
        <label className="field">
          <span>Бюджет в месяц, $ (0 — без предела)</span>
          <input id="ai-budget" className="input" inputMode="decimal" value={s.aiMonthlyBudgetUsd} onChange={(e) => patch({ aiMonthlyBudgetUsd: Math.max(0, Number(e.target.value.replace(',', '.')) || 0) })} />
        </label>
        <label className="field">
          <span>{PROVIDER_LABEL[s.aiProvider]}: $ за 1 млн входных токенов</span>
          <input id="ai-price-in" className="input" inputMode="decimal" value={price.inUsd} onChange={(e) => setPrice('inUsd', e.target.value)} />
        </label>
        <label className="field">
          <span>$ за 1 млн выходных токенов</span>
          <input id="ai-price-out" className="input" inputMode="decimal" value={price.outUsd} onChange={(e) => setPrice('outUsd', e.target.value)} />
        </label>
      </div>
      <p className="muted small">
        Цены смотрите на странице тарифов провайдера и указывайте для модели, заданной на сервере. Без цен считаются только запросы и токены, а
        бюджет не ограничивает. Сервер дополнительно ограничивает запросы в минуту и в сутки (wrangler.toml) — это защита, даже если токен утёк.
      </p>
      <div className="usage-grid" aria-label="Расход ИИ">
        <div>
          <strong>{usage.dayRequests}</strong>
          <small>запросов сегодня</small>
        </div>
        <div>
          <strong>{usage.monthRequests}</strong>
          <small>за месяц</small>
        </div>
        <div>
          <strong>{Math.round((usage.monthTokensIn + usage.monthTokensOut) / 1000)}K</strong>
          <small>токенов</small>
        </div>
        <div>
          <strong>
            {fmtUsd(usage.monthCostUsd)}
            {usage.costUnknown ? '+' : ''}
          </strong>
          <small>оценка за месяц</small>
        </div>
      </div>
      <ToggleRow
        title="Передавать ИИ местоположение"
        sub="Координаты округляются до ~100 м; маршрут, музыка и сервисная история передаются для ответов по делу"
        on={s.aiShareLocation}
        onChange={(on) => patch({ aiShareLocation: on })}
      />
      <div className="toolbar">
        <button type="button" className="btn" onClick={() => { resetUsage(); toast('Счётчики расхода обнулены', 'ok'); }}>
          Обнулить счётчики
        </button>
      </div>
    </form>
  );
}

function ToggleRow({ title, sub, on, onChange }: { title: string; sub: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <small>{sub}</small>
      </div>
      <Toggle on={on} onChange={onChange} label={title} />
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

function ResetButton() {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <div className="toolbar">
      <button
        className="btn btn-danger btn-lg"
        onClick={() => {
          Object.keys(localStorage)
            .filter((k) => k.startsWith('ace:'))
            .forEach((k) => localStorage.removeItem(k));
          location.reload();
        }}
      >
        Удалить всё
      </button>
      <button className="btn btn-lg" onClick={() => setArmed(false)}>
        Отмена
      </button>
    </div>
  ) : (
    <button className="btn btn-lg" onClick={() => setArmed(true)}>
      <Icon name="trash" /> Сбросить все данные
    </button>
  );
}
