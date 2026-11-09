/** Статус достоверности факта. Помощник обязан сообщать, если факт не подтверждён. */
export type FactStatus =
  | 'owner' // подтвердил владелец (видел в своём автомобиле / документах)
  | 'documented' // подтверждено официальным документом (руководство, сервисная книжка) — указан источник
  | 'typical' // типично для модели/поколения, но для этой комплектации не проверено
  | 'community'; // опыт владельцев и сервисов, не официальная информация

export const STATUS_LABEL: Record<FactStatus, string> = {
  owner: 'Подтверждено владельцем',
  documented: 'По документации',
  typical: 'Типично для модели — проверить',
  community: 'Опыт владельцев, неофициально',
};

export type KbTopic = 'identity' | 'engine' | 'climate' | 'controls' | 'safety' | 'service' | 'known-issues' | 'tips';

export const TOPIC_LABEL: Record<KbTopic, string> = {
  identity: 'Автомобиль',
  engine: 'Двигатель',
  climate: 'Климат-контроль',
  controls: 'Кнопки и органы управления',
  safety: 'Безопасность и помощники',
  service: 'Обслуживание',
  'known-issues': 'Известные особенности',
  tips: 'Советы по эксплуатации',
};

export interface KbFact {
  id: string;
  topic: KbTopic;
  title: string;
  text: string;
  status: FactStatus;
  /** Источник: название документа/раздела или «владелец». */
  source?: string;
  tags: string[];
  /** Короткая подсказка для ненавязчивого обучения (показ на главном экране / голосом). */
  tip?: string;
}
