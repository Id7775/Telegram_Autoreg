# Модели, ключи, цены

По умолчанию всё идёт через **fal.ai**: один ключ `FAL_KEY` покрывает все шаги. Модели меняются в `project.json → "models"`, параметры добавляются через `i2v_options`, `tts_options` (глобально, у персонажа или у реплики) и `music.options`.

| Шаг | Ключ в `models` | По умолчанию | Вход | Заметки |
|---|---|---|---|---|
| Лист персонажа / локация | `t2i` | `fal-ai/nano-banana` | prompt, aspect_ratio | ~$0.04 за картинку |
| Кадр сцены | `edit` | `fal-ai/nano-banana/edit` | prompt, image_urls[] (рефы) | держит лица по рефам; ~$0.04 |
| Оживление | `i2v` | `fal-ai/kling-video/v2.1/standard/image-to-video` | image_url, prompt, duration "5"/"10" | ~$0.25 за 5 с; `…/v2.1/master/…` красивее и дороже |
| Липсинк | `lipsync` | `fal-ai/kling-video/lipsync/audio-to-video` | video_url, audio_url | один говорящий в кадре |
| Голос | `tts` | `fal-ai/elevenlabs/tts/multilingual-v2` | text, voice | понимает русский |
| Музыка | `music` | `fal-ai/stable-audio` | prompt, seconds_total (≤47) | зацикливается под длину ролика |

Цены ориентировочные. Перед запуском назови пользователю число вызовов, например: «12 кадров ≈ $0.5, 12 клипов по 10 с ≈ $6».

Альтернативы, если пользователь хочет другие модели: `fal-ai/flux-pro/kontext` (edit, один реф, поле `image_url`), `fal-ai/kling-video/v2.1/master/image-to-video`, `fal-ai/minimax/hailuo-02/standard/image-to-video`, `fal-ai/minimax/speech-02-hd` (TTS). Если у модели другие имена полей, поменяй вызов в `studio.mjs` (функции `cmdFrames`, `cmdClips`, `cmdVoices`) или передай поля через `*_options`. Точные схемы смотри на странице модели на fal.ai (вкладка API).

## Голоса ElevenLabs (поле `voice`)
Женские: `Rachel` (спокойная), `Aria` (выразительная), `Sarah` (мягкая), `Charlotte` (взрослая, уверенная).
Мужские: `Brian` (низкий, ровный), `Roger` (уверенный), `Daniel` (строгий), `Liam` (молодой), `Chris` (разговорный).
Эмоцию усиливают `tts_options: { "stability": 0.3, "style": 0.6 }` у реплики. Ниже stability — живее голос.

## Ключ
- Локально: `export FAL_KEY=...` (Windows: `setx FAL_KEY ...`, затем перезапустить терминал).
- Облачная сессия Claude Code: `request_credential` для хоста `queue.fal.run`, `header_name: Authorization`, `prefix: Key`. Прокси сам подставит ключ, а `FAL_KEY` можно не задавать.

## Ошибки
- `HTTP 401/403`: нет ключа или он неверный. В облаке может быть заблокирован хост: проверь сетевые настройки окружения.
- `HTTP 422`: модель ждёт другие поля. Сверь со схемой модели и поправь вызов.
- `В ответе нет URL`: модель вернула ошибку в теле. Смотри текст в сообщении.
- Кадр «плывёт» или лица меняются в клипе: упрости `motion_prompt`, убери крупные движения, поставь `duration` 5 (`"clip_seconds": 5`).
- Не та сторона или не тот герой говорит: уточни в `image_prompt` и `motion_prompt`, кто слева и кто справа.
