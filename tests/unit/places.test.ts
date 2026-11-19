/* «Мои места»: перенос из прежних «Дом/Работа/Избранное», проверка записей, Дом и Работа единственные,
   изменение и удаление, импорт и экспорт, производные списки для голосовых команд. */
import { describe, it, expect, beforeEach } from 'vitest';
import { cleanPlace, cleanList, migrateOld, placesStore, savePlace, removePlace, placeOfType, findSaved, exportPlaces, importPlaces } from '../../src/lib/places';
import { savedPlacesStore, favoritesStore, setSavedPlace, toggleFavorite, knownPlace } from '../../src/lib/nav';

const home = { id: 'n1', name: 'ул. Шевченко, 5', address: 'Днепр', lat: 48.46, lon: 35.04 };
const office = { id: 'n2', name: 'Бизнес-центр', address: 'пр. Яворницкого, 1', lat: 48.47, lon: 35.05 };

beforeEach(() => placesStore.set([]));

describe('Перенос прежних данных', () => {
  it('«Дом», «Работа» и «Избранное» переносятся в «Мои места»; дубль избранного по координатам не создаётся', () => {
    const out = migrateOld({ home, work: office }, [{ ...home, id: 'f1' }, { id: 'f2', name: 'Гараж', address: '', lat: 48.5, lon: 35.1 }], 1);
    expect(out.map((p) => [p.placeType, p.label])).toEqual([
      ['home', 'Дом'],
      ['work', 'Работа'],
      ['custom', 'Гараж'],
    ]);
    expect(out[0]).toMatchObject({ lat: 48.46, lon: 35.04, address: 'Днепр' });
  });
  it('нет прежних данных или они повреждены — пустой список без ошибок', () => {
    expect(migrateOld(undefined, undefined)).toEqual([]);
    expect(migrateOld('мусор', { a: 1 })).toEqual([]);
    expect(migrateOld({ home: { lat: 'x' } }, [{ lat: 999, lon: 0 }])).toEqual([]);
  });
});

describe('Проверка записей', () => {
  it('без координат или с неверными — отбрасывается; без названия — название по координатам', () => {
    expect(cleanPlace({ name: 'A' })).toBeNull();
    expect(cleanPlace({ lat: 91, lon: 0 })).toBeNull();
    expect(cleanPlace({ lat: 48.1, lon: 35.2 })).toMatchObject({ name: '48.10000, 35.20000', placeType: 'custom' });
    expect(cleanPlace({ lat: 48.1, lon: 35.2, placeType: 'castle', label: '  Дача  ' })).toMatchObject({ placeType: 'custom', label: 'Дача' });
  });
  it('повторяющиеся id в списке не дублируются', () => {
    expect(cleanList([{ id: 'a', lat: 1, lon: 1 }, { id: 'a', lat: 2, lon: 2 }, null])).toHaveLength(1);
  });
});

describe('Изменение мест', () => {
  it('любое количество мест со своими названиями и типами: Дом, Работа, Гараж, СТО, своё', () => {
    savePlace({ ...home, id: undefined, placeType: 'home', label: 'Дом' });
    savePlace({ ...office, id: undefined, placeType: 'work', label: 'Работа' });
    savePlace({ lat: 48.5, lon: 35.1, name: 'x', placeType: 'garage', label: 'Гараж' });
    savePlace({ lat: 48.51, lon: 35.11, name: 'y', placeType: 'service', label: 'СТО на Слобожанском' });
    for (let i = 0; i < 20; i++) savePlace({ lat: 48 + i / 100, lon: 36, name: `Место ${i}`, placeType: 'custom', label: `Место ${i}` });
    expect(placesStore.get()).toHaveLength(24);
    expect(placeOfType('service')?.label).toBe('СТО на Слобожанском');
  });
  it('новый «Дом» не стирает прежний: прежний становится обычным местом с пометкой', () => {
    savePlace({ ...home, id: undefined, placeType: 'home', label: 'Дом' });
    savePlace({ ...office, id: undefined, placeType: 'home', label: 'Дом' });
    const list = placesStore.get();
    expect(list).toHaveLength(2);
    expect(list.filter((p) => p.placeType === 'home')).toHaveLength(1);
    expect(placeOfType('home')?.lat).toBe(office.lat);
    expect(list.find((p) => p.lat === home.lat)).toMatchObject({ placeType: 'custom', label: 'Дом (прежний)' });
  });
  it('переименование и изменение точки — та же запись (по id); удаление', () => {
    const p = savePlace({ ...home, id: undefined, placeType: 'custom', label: 'Дача' })!;
    savePlace({ ...p, label: 'Дача у реки', lat: 48.6, lon: 35.3 });
    expect(placesStore.get()).toHaveLength(1);
    expect(placesStore.get()[0]).toMatchObject({ id: p.id, label: 'Дача у реки', lat: 48.6 });
    removePlace(p.id);
    expect(placesStore.get()).toEqual([]);
  });
});

describe('Совместимость с прежним кодом (голос, «Домой», звёздочка)', () => {
  it('«Сделать домом» и «Сделать работой» — в «Моих местах»; «Дом» и «Работа» видят команды «едем домой»', () => {
    setSavedPlace('home', home);
    setSavedPlace('work', office);
    expect(savedPlacesStore.get().home).toMatchObject({ lat: home.lat, label: 'Дом' });
    expect(savedPlacesStore.get().work).toMatchObject({ lat: office.lat });
    expect(knownPlace('домой')).toMatchObject({ lat: home.lat });
    setSavedPlace('home', null);
    expect(savedPlacesStore.get().home).toBeNull();
    expect(placesStore.get()).toHaveLength(1);
  });
  it('то же место «Сделать домом» — тип меняется, дубля нет', () => {
    toggleFavorite(home);
    setSavedPlace('home', home);
    expect(placesStore.get()).toHaveLength(1);
    expect(placesStore.get()[0].placeType).toBe('home');
  });
  it('звёздочка добавляет и убирает место; голосом находится по названию («едем в гараж»)', () => {
    savePlace({ lat: 48.5, lon: 35.1, name: 'ул. Гаражная, 3', placeType: 'garage', label: 'Гараж' });
    expect(knownPlace('гараж')).toMatchObject({ name: 'Гараж', lat: 48.5 });
    toggleFavorite(office);
    expect(findSaved(office)).toBeTruthy();
    expect(favoritesStore.get().some((f) => f.lat === office.lat)).toBe(true);
    toggleFavorite(office);
    expect(findSaved(office)).toBeNull();
  });
});

describe('Экспорт и импорт', () => {
  it('копия в файл и загрузка: без дублей, ничего не удаляется, второй «Дом» становится обычным местом', () => {
    savePlace({ ...home, id: undefined, placeType: 'home', label: 'Дом' });
    const file = exportPlaces();
    expect(JSON.parse(file)).toMatchObject({ app: 'ai-car-expert', type: 'places' });
    expect(importPlaces(file)).toEqual({ added: 0, skipped: 1 });
    const other = JSON.stringify({ places: [{ ...office, placeType: 'home', label: 'Дом мамы' }, { lat: 48.9, lon: 35.9, label: 'СТО', placeType: 'service' }] });
    expect(importPlaces(other)).toEqual({ added: 2, skipped: 0 });
    expect(placesStore.get().filter((p) => p.placeType === 'home')).toHaveLength(1);
    expect(placesStore.get().find((p) => p.label === 'Дом мамы')?.placeType).toBe('custom');
  });
  it('неверный файл — понятная ошибка, места не меняются', () => {
    savePlace({ ...home, id: undefined, placeType: 'home', label: 'Дом' });
    expect(() => importPlaces('не json')).toThrow(/не похож/);
    expect(() => importPlaces('{"a":1}')).toThrow(/нет списка/);
    expect(placesStore.get()).toHaveLength(1);
  });
});
