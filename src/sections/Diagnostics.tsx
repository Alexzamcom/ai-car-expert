import { useState } from 'react';
import { Icon } from '../components/Icon';
import { decodeDtc, type DtcInfo } from '../lib/dtc';
import { openSection } from '../lib/state';
import { sendToAssistant } from '../lib/assistant';

const KEYS = ['P', 'C', 'B', 'U', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'];

export function Diagnostics() {
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<DtcInfo | null>(null);

  // Допустимость нажатия контролирует клавиатура (disabled), здесь просто добавляем символ.
  const press = (k: string) => {
    setInfo(null);
    setCode((c) => (c.length < 5 ? c + k : c));
  };

  const letters = code.length === 0;

  return (
    <div className="section diagnostics">
      <div className="notice notice-info">
        <Icon name="plug" size="1.8rem" />
        <div>
          <strong>OBD-II адаптер не подключён — модуль в разработке</strong>
          <p>
            Чтение кодов и параметров двигателя в реальном времени появится после интеграции с адаптером
            ELM327 (Wi-Fi/Bluetooth LE). Сейчас доступна расшифровка кода, считанного любым сканером.
          </p>
        </div>
      </div>

      <div className="dtc card">
        <h3 className="section-title">Расшифровка кода ошибки</h3>
        <div className="dtc-display" aria-live="polite">
          {Array.from({ length: 5 }).map((_, i) => (
            <span key={i} className={i < code.length ? 'is-filled' : i === code.length ? 'is-cursor' : ''}>
              {code[i] ?? ''}
            </span>
          ))}
        </div>
        <div className="keypad">
          {KEYS.map((k, i) => {
            const isLetterKey = i < 4;
            const disabled = letters ? !isLetterKey : isLetterKey || code.length >= 5 || (code.length === 1 && !'0123'.includes(k));
            return (
              <button key={i} className="key" disabled={disabled} onClick={() => press(k)}>
                {k}
              </button>
            );
          })}
          <button className="key key-wide" onClick={() => (setCode((c) => c.slice(0, -1)), setInfo(null))} disabled={!code}>
            <Icon name="back" /> Стереть
          </button>
          <button className="key key-wide key-primary" disabled={code.length !== 5} onClick={() => setInfo(decodeDtc(code))}>
            <Icon name="search" /> Расшифровать
          </button>
        </div>

        {info && (
          <div className="dtc-result">
            {info.valid ? (
              <>
                <div className="dtc-code">{info.code}</div>
                <div className="dtc-desc">{info.description ?? 'Кода нет во встроенном справочнике'}</div>
                <dl>
                  <dt>Система</dt>
                  <dd>{info.system}</dd>
                  {info.subsystem && (
                    <>
                      <dt>Подсистема</dt>
                      <dd>{info.subsystem}</dd>
                    </>
                  )}
                  <dt>Тип кода</dt>
                  <dd>{info.origin}</dd>
                </dl>
                <button
                  className="btn btn-primary btn-lg"
                  onClick={() => {
                    openSection('assistant');
                    void sendToAssistant(`Код ошибки ${info.code}: что означает, возможные причины и насколько срочно?`);
                  }}
                >
                  <Icon name="spark" /> Спросить AI о причинах
                </button>
              </>
            ) : (
              <div className="text-warn">Неверный формат кода</div>
            )}
          </div>
        )}
      </div>

      <h3 className="section-title">Что будет в OBD-модуле</h3>
      <div className="roadmap">
        {[
          ['gauge', 'Параметры в реальном времени', 'Обороты, температура ОЖ, напряжение, нагрузка'],
          ['alert', 'Чтение и сброс ошибок', 'С объяснением от AI-помощника'],
          ['fuel', 'Расход и поездки', 'Статистика по данным ЭБУ'],
          ['wrench', 'Связь с историей ТО', 'Автоматический пробег и напоминания'],
        ].map(([icon, title, sub]) => (
          <div key={title} className="roadmap-item">
            <Icon name={icon as 'gauge'} size="1.8rem" />
            <div>
              <strong>{title}</strong>
              <small>{sub}</small>
            </div>
            <span className="badge badge-off">Скоро</span>
          </div>
        ))}
      </div>
    </div>
  );
}
