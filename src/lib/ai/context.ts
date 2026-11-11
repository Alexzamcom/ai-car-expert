/* Актуальный контекст для ИИ: геопозиция, маршрут, автомобиль, музыка, сервис.
   Компактный текст (меньше токенов — дешевле и быстрее). Координаты — округлённые, их можно отключить. */
import { settingsStore, serviceStore, nextServiceEstimate, vehicleName, SERVICE_CATEGORIES } from '../state';
import { geoStore, navStore } from '../nav';
import { playerStore } from '../player';
import { musicStore } from '../music/sources';
import { activeReminders, isDue, reminderLabel } from '../reminders';
import { fmtDistance, stepText } from '../routing';

const hhmm = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function buildContext(now = new Date()): string {
  const s = settingsStore.get();
  const v = s.vehicle;
  const geo = geoStore.get();
  const nav = navStore.get();
  const player = playerStore.get();
  const music = musicStore.get();
  const records = serviceStore.get();
  const next = nextServiceEstimate(records, v);
  const lines: string[] = [];

  lines.push(`Время: ${now.toLocaleDateString('ru-RU')} ${hhmm(now)}. Язык водителя: ${s.speechLang.startsWith('uk') ? 'українська' : 'русский'}.`);

  if (geo.lat != null && geo.lon != null) {
    const parts = [s.aiShareLocation ? `координаты ≈${geo.lat.toFixed(3)}, ${geo.lon.toFixed(3)}` : 'координаты скрыты настройкой'];
    if (geo.speedKmh != null) parts.push(`скорость ${Math.round(geo.speedKmh)} км/ч`);
    lines.push(`Положение: ${parts.join(', ')}.`);
  } else {
    lines.push(`Положение: неизвестно (${geo.status === 'denied' ? 'геолокация запрещена' : 'нет GPS'}).`);
  }

  if (nav.dest) {
    const r = nav.route;
    const p = nav.progress;
    const status = { idle: 'нет', routing: 'строится', preview: 'построен, ведение не начато', guiding: 'идёт ведение', arrived: 'прибыли' }[nav.status];
    const parts = [`до «${nav.dest.name}»${nav.dest.address ? ` (${nav.dest.address})` : ''}`, status];
    if (nav.via) parts.push(`остановка: ${nav.via.name}`);
    if (r) {
      const remainM = p?.remainingM ?? r.distance;
      const remainS = r.duration * (remainM / Math.max(1, r.distance));
      parts.push(`осталось ${fmtDistance(remainM)}, ~${Math.round(remainS / 60)} мин, прибытие ~${hhmm(new Date(now.getTime() + remainS * 1000))} (без пробок)`);
      const step = p ? r.steps[p.stepIndex] : null;
      if (nav.status === 'guiding' && step && p) parts.push(`ближайший манёвр через ${fmtDistance(p.toStepM)}: ${stepText(step, 'ru')}`);
    }
    if (nav.error) parts.push(`ошибка: ${nav.error}`);
    lines.push(`Маршрут: ${parts.join('; ')}.`);
  } else {
    lines.push('Маршрут: нет.');
  }

  const src = music.active === 'youtube-music' ? 'YouTube Music (отдельное приложение; что играет — неизвестно, управлять им нельзя)' : 'интернет-радио';
  lines.push(`Музыка: источник ${src}${player.current ? `; радио «${player.current.title}» ${player.playing ? 'играет' : 'на паузе'}` : ''}.`);

  lines.push(
    `Автомобиль: ${vehicleName(v) || 'не указан'}${v.engine ? `, ${v.engine}` : ''}${v.odometerKm != null ? `, пробег ${v.odometerKm} км` : ', пробег не указан'}.`,
  );
  if (next) {
    lines.push(
      `Следующее ТО: ${next.dueDate.toLocaleDateString('ru-RU')}${next.dueKm ? ` или ${next.dueKm} км` : ''}${next.daysLeft < 0 ? ' (просрочено)' : ''}.`,
    );
  } else lines.push('Плановое ТО: записей нет.');
  if (records.length) {
    lines.push(
      `Последние работы: ${records
        .slice(0, 5)
        .map((r) => `${r.date} ${SERVICE_CATEGORIES[r.category]}${r.title ? ` (${r.title})` : ''}${r.odometerKm ? `, ${r.odometerKm} км` : ''}`)
        .join('; ')}.`,
    );
  }
  const rem = activeReminders(now).slice(0, 5);
  if (rem.length) lines.push(`Напоминания: ${rem.map((r) => `${reminderLabel(r)}${isDue(r, now) ? ' [срок наступил]' : ''}`).join('; ')}.`);
  return lines.join('\n');
}
