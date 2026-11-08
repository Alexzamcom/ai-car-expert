import { useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { settingsStore, toast, type Settings as SettingsT, type VehicleProfile } from '../lib/state';
import { wakeLockSupported } from '../lib/wakeLock';
import { speechRecognitionSupported } from '../lib/speech';

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
  const [endpoint, setEndpoint] = useState(s.aiEndpoint);
  const [token, setToken] = useState(s.aiToken);

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

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          const url = endpoint.trim();
          if (url && !/^https:\/\//.test(url) && !/^http:\/\/localhost/.test(url)) {
            toast('Адрес AI-сервиса должен начинаться с https://', 'warn');
            return;
          }
          patch({ aiEndpoint: url, aiToken: token.trim() });
          toast(url ? 'AI-сервис подключён' : 'AI-сервис отключён', 'ok');
        }}
      >
        <h3 className="section-title">
          <Icon name="spark" /> AI-помощник
        </h3>
        <p className="muted">
          Адрес вашего AI-сервиса (прокси к языковой модели). Без него помощник отвечает из встроенной базы. Ключи
          провайдера храните на сервере, а не в приложении. Формат запроса описан в README.
        </p>
        <div className="form-grid">
          <label className="field field-wide">
            <span>Адрес сервиса</span>
            <input className="input" inputMode="url" placeholder="https://example.com/api/chat" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
          </label>
          <label className="field field-wide">
            <span>Токен доступа к сервису (необязательно)</span>
            <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </label>
        </div>
        <button className="btn btn-primary btn-lg" type="submit">
          <Icon name="check" /> Сохранить
        </button>
      </form>

      <div className="card">
        <h3 className="section-title">
          <Icon name="mic" /> Голос и экран
        </h3>
        <div className="setting-row">
          <div>
            <strong>Озвучивать ответы</strong>
            <small>Ответы помощника читаются вслух</small>
          </div>
          <Toggle on={s.speakReplies} onChange={(on) => patch({ speakReplies: on })} />
        </div>
        <div className="setting-row">
          <div>
            <strong>Язык речи</strong>
            <small>{speechRecognitionSupported() ? 'Распознавание речи доступно' : 'Распознавание недоступно — используйте диктовку клавиатуры'}</small>
          </div>
          <div className="seg">
            {[
              ['ru-RU', 'Русский'],
              ['en-US', 'English'],
            ].map(([code, label]) => (
              <button key={code} className={`chip ${s.speechLang === code ? 'is-active' : ''}`} onClick={() => patch({ speechLang: code })}>
                {label}
              </button>
            ))}
          </div>
        </div>
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
          <Toggle on={s.keepAwake} onChange={(on) => patch({ keepAwake: on })} />
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

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} className={`toggle ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)}>
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
