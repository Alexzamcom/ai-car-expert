# Постоянная подпись тестовых APK

PR #59 и первые сборки PR #60 использовали отладочный ключ временного раннера. В Actions сохранились APK и публичные сертификаты. Закрытый ключ PR #59 недоступен. При переходе на постоянный сертификат понадобится одна чистая установка. Скачайте нужную офлайн-карту заново после перехода.

## 1. Создать ключ и сделать резервную копию

Владелец выполняет команды на своём доверенном компьютере в терминале Bash с JDK. Команды создают хранилище вне репозитория. Сгенерируйте длинный уникальный пароль в менеджере паролей и введите его в запросе `keytool`.

```bash
umask 077
mkdir -p "$HOME/.ace-android-signing"
keystore="$HOME/.ace-android-signing/ace-test.p12"
keytool -genkeypair -storetype PKCS12 -keyalg RSA -keysize 3072 \
  -validity 10000 -alias ace-test -keystore "$keystore" \
  -dname "CN=AI Car Expert Android Test"
keytool -list -v -keystore "$keystore" -alias ace-test
```

Сохраните пароль в менеджере паролей. Скопируйте PKCS12 в отдельное защищённое хранилище или на зашифрованный носитель. Проверьте резервную копию командой `keytool -list -v -keystore /путь/к/копии/ace-test.p12 -alias ace-test` и сравните SHA‑256 сертификата с оригиналом. Держите пароль отдельно от резервного файла. Не используйте один пароль для других ключей.

## 2. Настроить защиту GitHub

1. В [Settings → Environments](https://github.com/Alexzamcom/ai-car-expert/settings/environments) создайте `android-test-signing`.
2. В **Deployment branches and tags** выберите **Selected branches and tags** и добавьте точную ветку `codex/android-offline-recovery`. Добавьте обязательного проверяющего, если эта настройка доступна, и защитите саму ветку от недоверенных изменений. Проверяйте изменение workflow перед одобрением.
3. В **Environment variables** задайте `ANDROID_TEST_KEY_ALIAS=ace-test` и `ANDROID_TEST_CERT_SHA256` с отпечатком из `keytool` в виде 64 HEX-символов без двоеточий.
4. Добавьте **Environment secrets** `ANDROID_TEST_KEYSTORE_BASE64`, `ANDROID_TEST_STORE_PASSWORD` и `ANDROID_TEST_KEY_PASSWORD`. Пароли для указанного PKCS12 совпадают. С авторизованным GitHub CLI и правами владельца можно записать секреты прямо из терминала, без вывода ключа или пароля:

```bash
set -e -o pipefail
repo=Alexzamcom/ai-car-expert
keystore="$HOME/.ace-android-signing/ace-test.p12"
base64 < "$keystore" | tr -d '\r\n' |
  gh secret set ANDROID_TEST_KEYSTORE_BASE64 --repo "$repo" --env android-test-signing
read -rs -p 'Пароль PKCS12: ' ace_test_password
printf '\n'
printf '%s' "$ace_test_password" |
  gh secret set ANDROID_TEST_STORE_PASSWORD --repo "$repo" --env android-test-signing
printf '%s' "$ace_test_password" |
  gh secret set ANDROID_TEST_KEY_PASSWORD --repo "$repo" --env android-test-signing
unset ace_test_password
```

5. После настройки защиты и секретов добавьте **переменную репозитория** `ANDROID_TEST_STABLE_SIGNING=true` в **Settings → Secrets and variables → Actions → Variables**. Ключ и пароли вводятся только в секреты окружения. SHA‑256 и псевдоним ключа являются публичными данными.

## 3. Выпустить два тестовых APK

Запустите **Android stable test APKs** для `codex/android-offline-recovery`. Если кнопка **Run workflow** недоступна, пока файл workflow есть только в Draft PR, отправьте пустой коммит в эту ветку из актуального чистого локального клона:

```bash
git switch codex/android-offline-recovery
git pull --ff-only
git commit --allow-empty -m "Build permanently signed Android test APKs"
git push origin codex/android-offline-recovery
```

Одобрите развёртывание окружения, если настроено одобрение. Workflow компилирует два неподписанных APK с последовательными `versionCode`, подписывает оба одним ключом, сверяет ожидаемый сертификат и выполняет `adb install -r` на Android-эмуляторе. Проверка читает тестовые записи офлайн-хранилища, сохранённое место и настройки после повторного запуска. Секреты доступны только заданию подписи. При ошибке проверки ключа подписанный артефакт не публикуется.

Скачайте артефакт **ai-car-expert-android-stable-test-apks** после проверки шага `upgrade`. Внутри находятся `baseline.apk` и `update.apk`. После однократной чистой установки `baseline.apk` на Note 9 скачайте регион и затем установите `update.apk` поверх него. Для обычного тестирования можно сразу чисто установить `update.apk`. Будущие сборки из этих запусков получают более высокий `versionCode` и используют тот же сертификат. Архив из PR-проверки **unsigned-android-test-apks** служит для проверки компиляции и не устанавливается на устройство.
