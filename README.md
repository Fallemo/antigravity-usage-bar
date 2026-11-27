# Antigravity Pro Usage Bar

Extensie ușoară pentru VS Code care afișează în Status Bar (jos în dreapta, chiar lângă Claude Code) procentul de usage pentru **Google Antigravity / Gemini Pro**:

`✦ Gem 5h 12% · wk 28%`

## Funcționalități
- **Monitorizare în timp real:** urmărește automat conversațiile locale Antigravity din VS Code (`~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl`), cântărind diferit modelele grele (`Gemini 4 Carbon` / `Neon`) față de cele ușoare (`Gemini 4 Hydrogen` / `Flash`).
- **Alerte vizuale în bară:** fundal **galben** peste `70%`, **roșu** peste `90%`.
- **Hover & Dashboard:** arată bare de progres pentru `5h` și `wk` (7 zile), numărul de comenzi și peste cât timp începe să se elibereze fereastra de 5 ore.
- **Sincronizare cu 1 click:** click pe indicatorul din bară → **Sincronizează % cu Antigravity Settings → Models** pentru a alinia procentul cu cel oficial din `Antigravity: Open Settings` și a calibra automat scala pe contul tău.

## Instalare rapidă (pe orice PC)

1. Descarcă fișierul `antigravity-usage-bar-0.1.0.vsix` din secțiunea **[Releases](https://github.com/Fallemo/antigravity-usage-bar/releases)**.
2. Instalează-l în VS Code din terminal:
   ```bash
   code --install-extension antigravity-usage-bar-0.1.0.vsix --force
   ```
   *(sau în VS Code: `Extensions` → `...` → **Install from VSIX...**)*
3. Rulează `Ctrl + Shift + P` → **Developer: Reload Window**.
