# Przewodnik konfiguracji

*Wersja angielska: [`configuration.md`](configuration.md)*

AILoc2 czyta ustawienia atrybucji z pliku konfiguracyjnego w repozytorium. Ten przewodnik opisuje wszystkie opcje, sposób łączenia dwóch warstw konfiguracji oraz to, co każde ustawienie faktycznie zmienia w raportowanym procencie.

Wartości domyślne odpowiadają dotychczasowemu zachowaniu, więc istniejące repozytorium działa dokładnie tak jak wcześniej, dopóki czegoś nie zmienisz.

## Dwie warstwy

| Plik | Commitowany? | Przeznaczenie |
| --- | --- | --- |
| `.ailoc2-probe.json` (katalog główny repo) | **Tak** | Polityka zespołu. Podróżuje razem z repozytorium, więc wszyscy liczą commity tak samo. |
| `.ailoc2-metrics/config.json` | Nie — `.ailoc2-metrics/` jest w `.gitignore` | Prywatne nadpisanie dla jednej maszyny. |

`.ailoc2-probe.json` jest tworzony z wartościami domyślnymi przy uruchomieniu **Install Repo Hooks**. Nigdy nie jest nadpisywany przy ponownej instalacji, więc Twoje zmiany są bezpieczne, i celowo nie trafia do `.gitignore`, żeby dało się go zacommitować.

Plik lokalny jest opcjonalny i może być częściowy — wypisz tylko te klucze, które chcesz nadpisać.

### Jak łączą się warstwy

Każde ustawienie poza `excludePaths` łączy się **per klucz**: jeśli plik lokalny je podaje, wygrywa wartość lokalna; w przeciwnym razie obowiązuje wartość zespołowa; a jeśli i jej nie ma — wartość domyślna.

```jsonc
// .ailoc2-probe.json  (zespół)
{ "attribution": { "mode": "signals", "largeFileIsAI": false } }

// .ailoc2-metrics/config.json  (Ty)
{ "attribution": { "mode": "markers" } }

// efektywnie: mode = "markers"  (wygrywa wartość lokalna)
//             largeFileIsAI = false  (wartość zespołowa, nienadpisana)
```

`excludePaths` działa inaczej: obie listy są **łączone**, najpierw zespołowa, potem lokalna. Ponieważ dopasowanie działa według zasady „wygrywa ostatnie trafienie”, pozwala to ponownie włączyć coś, co zespół wykluczył (zobacz [Wykluczanie ścieżek](#wykluczanie-ścieżek)).

## Pełny przykład

```json
{
  "version": 1,
  "attribution": {
    "mode": "signals",
    "largeFileIsAI": true,
    "newFileIsAI": true,
    "excludePaths": []
  }
}
```

| Klucz | Typ | Domyślnie | Znaczenie |
| --- | --- | --- | --- |
| `version` | number | `1` | Wersja schematu konfiguracji. |
| `attribution.mode` | `"signals"` \| `"markers"` | `"signals"` | Sposób ustalania atrybucji. Zobacz [Tryby atrybucji](#tryby-atrybucji). |
| `attribution.largeFileIsAI` | boolean | `true` | Czy duża wstawka jest liczona jako AI. |
| `attribution.newFileIsAI` | boolean | `true` | Czy wypełnienie zupełnie nowego pliku jest liczone jako AI. |
| `attribution.excludePaths` | string[] | `[]` | Wzorce w stylu `.gitignore` wykluczone z atrybucji. |

Nieznane klucze są ignorowane. Plik uszkodzony lub niedający się sparsować cofa się do wartości domyślnych i zapisuje ostrzeżenie, zamiast przerywać commit.

## Tryby atrybucji

### `signals` (domyślny)

Model pasywny: AILoc2 obserwuje aktywność edytora i czatu, wywołania narzędzi Claude Code oraz kształt edycji, a następnie klasyfikuje każdą zmianę. Nie piszesz żadnych znaczników. To zachowanie opisane w [`attribution-and-summary.md`](attribution-and-summary.md).

### `markers`

Model dotychczasowy — dla zespołów, które nadal oznaczają kod AI ręcznie. Atrybucja wynika **wyłącznie** z komentarzy `AI start` / `AI stop`:

- dodana linia wewnątrz bloku znaczników → **AI**
- każda inna dodana linia → **Human**

To *wyłączne zastąpienie*. Korelacja z czatem, heurystyki dużych wstawek, pochodzenie z Claude Code oraz zapisany stan kroczący są przy liczeniu całkowicie pomijane. Nic nie trafia do kubełka Unknown.

```ts
const handWritten = 1;
// AI start
const generatedOne = 2;
const generatedTwo = 3;
// AI stop
const alsoHandWritten = 4;
```

Powyższy przykład raportuje 2 linie AI i 2 linie Human.

**Składnia znaczników.** Znacznik jest dopasowywany w dowolnym miejscu linii, a znak komentarza nie ma znaczenia, więc jedna reguła obsługuje każdy język:

```
// AI start        # AI start        -- AI start
/* AI start */     <!-- AI start -->
```

Dopasowanie nie zwraca uwagi na wielkość liter i toleruje separatory, więc `AI stop`, `ai_stop`, `AI-STOP` i `Ai   Stop` są rozpoznawane. Wymagana jest granica słowa, więc identyfikator w rodzaju `aiStartupCost` nie zostanie pomylony ze znacznikiem.

**Zasady liczenia.**

- Same linie znaczników są wyłączone zarówno z liczby AI, jak i z sumy.
- Bloki się zagnieżdżają: wewnętrzny `AI stop` zamyka tylko blok wewnętrzny.
- Stan bloku zeruje się przy każdym pliku, więc niezamknięty blok nigdy nie „przecieka” do następnego pliku w diffie.
- Linie puste i zawierające wyłącznie białe znaki nie są liczone.
- Liczone są tylko linie dodane (`+`); usunięcia i linie kontekstu są pomijane.

### Znaczniki są usuwane przy commicie

W trybie `markers` AILoc2 liczy zmiany z przechowalni (staged), a następnie **usuwa linie znaczników z indeksu i z katalogu roboczego**, więc znaczniki nigdy nie trafiają do commita. Odtwarza to zachowanie pierwotnego narzędzia, w którym znaczniki były tymczasową pomocą przy edycji.

Wszystko pozostałe zostaje bajt w bajt identyczne. Mechanizm usuwania:

- zachowuje znaki końca linii pliku oraz to, czy plik kończył się znakiem nowej linii
- zachowuje bit wykonywalności
- pomija linki symboliczne, submoduły i pliki z treścią binarną
- nadpisuje katalog roboczy **tylko** wtedy, gdy nadal odpowiada temu, co zostało dodane do przechowalni, więc niezacommitowana praca w toku nigdy nie zostaje nadpisana

Jeśli wolisz zachować znaczniki w kodzie źródłowym, pozostań w trybie `signals`.

## Duże wstawki i nowe pliki

Dwa osobne przełączniki, bo odpowiadają na różne pytania.

| Ustawienie | `true` (domyślnie) | `false` |
| --- | --- | --- |
| `largeFileIsAI` | Duża wstawka lub duże rozszerzenie jest traktowane jako skłaniające się do AI. | Zmiana jest przypisywana do **Human** i nie podnosi procentu AI. |
| `newFileIsAI` | Wypełnienie zupełnie nowego pliku jest traktowane jako skłaniające się do AI. | Zmiana jest przypisywana do **Human**. |

Wyłącz `largeFileIsAI`, jeśli Twoje repozytorium regularnie wchłania treść, której nie napisałeś z AI: biblioteki dostawców, generowane klienty API, duże mechaniczne refaktoryzacje albo wklejone dane testowe.

Dwie rzeczy warte zapamiętania:

- **Silniejsze dowody nadal wygrywają.** Te przełączniki wpływają tylko na domysł oparty na rozmiarze. Jeśli AILoc2 ma prawdziwy dowód — zastosowanie zmiany z czatu albo zarejestrowaną edycję Claude Code — zmiana nadal zostanie przypisana do AI, niezależnie od tych flag.
- **Są naprawdę niezależne.** Wyłączenie `largeFileIsAI` nie zmienia obsługi nowych plików i odwrotnie.

## Wykluczanie ścieżek

`excludePaths` całkowicie usuwa pliki z atrybucji. Wykluczony plik nie jest liczony **ani** w liczniku AI, **ani** w sumie, więc nie może przesunąć Twojego procentu w żadną stronę, i nie jest dla niego przechowywany stan atrybucji.

```json
{
  "attribution": {
    "excludePaths": [
      "vendor/**",
      "*.generated.ts",
      "src/legacy/",
      "!src/legacy/keep-scoring-this.ts"
    ]
  }
}
```

**Składnia wzorców** jest w stylu `.gitignore`:

| Wzorzec | Dopasowuje |
| --- | --- |
| `vendor/**` | wszystko pod `vendor/` na dowolnej głębokości |
| `*.generated.ts` | dowolny plik z tą końcówką, w dowolnym katalogu |
| `/build` | `build` tylko w katalogu głównym repo (wiodący `/` zakotwicza) |
| `dist/` | katalog `dist` i jego zawartość |
| `file?.ts` | `file1.ts`, `fileA.ts` — `?` to jeden znak |
| `[abc]*.ts` | klasy znaków, oraz `[!abc]` do negacji |
| `# komentarz` | pomijane |
| `!wzorzec` | ponownie włącza coś, co wykluczył wcześniejszy wzorzec |

**Wygrywa ostatni dopasowany wzorzec.** W połączeniu z łączeniem „najpierw zespół, potem lokalnie” właśnie to sprawia, że prywatne ponowne włączanie działa:

```jsonc
// .ailoc2-probe.json  (zespół) — wyklucz cały vendor/
{ "attribution": { "excludePaths": ["vendor/**"] } }

// .ailoc2-metrics/config.json  (Ty) — ale licz ten jeden plik
{ "attribution": { "excludePaths": ["!vendor/my-active-work.js"] } }
```

### `excludePaths` a `.ailoc2-metrics/.ignore`

Oba przyjmują tę samą składnię wzorców i oba wyłączają plik z liczenia. Do wszystkiego, co ma obowiązywać cały zespół, używaj `excludePaths`, ponieważ `.ailoc2-metrics/` jest w `.gitignore`, więc pliku `.ignore` nie da się współdzielić. `.ignore` pozostaje wspierany dla wykluczeń lokalnych dla danej maszyny.

## Zmiana ustawień z IDE

Typowych przełączników nie musisz ustawiać, edytując JSON ręcznie.

- **VS Code** — uruchom `AILoc2 Probe: Attribution Settings` z palety komend. Wybierz repozytorium, a potem przełącz tryb, `largeFileIsAI` lub `newFileIsAI`. Pozycja **Edit excluded paths…** otwiera bezpośrednio `.ailoc2-probe.json`.
- **IntelliJ IDEA** — **Tools → AILoc2 Probe: Attribution Settings**.

Oba zapisują do warstwy **lokalnej** (`.ailoc2-metrics/config.json`), więc szybkie przełączenie nigdy nie modyfikuje zacommitowanej polityki zespołu. Aby zmienić politykę zespołu, edytuj `.ailoc2-probe.json` samodzielnie. Oba odświeżają też natychmiast podsumowanie repozytorium, więc efekt jest widoczny od razu.

## Pliki, których to dotyczy

```text
twoje-repo/
├─ .ailoc2-probe.json                    # polityka zespołu — to commituj
└─ .ailoc2-metrics/
   ├─ config.json                        # Twoje lokalne nadpisanie (opcjonalne)
   ├─ resolved-config.env                # generowany; nie edytuj
   └─ .ignore                            # dotychczasowe wykluczenia lokalne
```

`resolved-config.env` to spłaszczona kopia połączonych ustawień, zapisywana dla generowanego hooka powłoki w IntelliJ, który nie potrafi parsować JSON-a. Jest generowany ponownie przy instalacji, przy każdym przełączeniu i przed każdym commitem z IDE, więc automatycznie podąża za Twoim JSON-em. Edytuj JSON, nigdy plik `.env`.

## Rozwiązywanie problemów

**Moja zmiana w konfiguracji nie zadziałała.**
Oba IDE cache'ują konfigurację i czytają ją ponownie, gdy zmieni się znacznik czasu lub rozmiar pliku; przełączenie z menu akcji unieważnia cache jawnie. Po ręcznej edycji uruchom **Recompute Repo Summary**, aby zobaczyć nowe liczby.

**Wyłączyłem `largeFileIsAI`, ale procent się nie zmienił.**
Najprawdopodobniej AILoc2 miał dowód silniejszy niż rozmiar — zastosowanie zmiany z czatu albo edycję Claude Code — którego ta flaga nie tłumi. Zwróć też uwagę, że plik bez żadnego zapisanego stanu atrybucji nadal jest liczony jako AI przez mechanizm awaryjny dla nierozstrzygniętych linii; ten mechanizm jest niezależny od tego ustawienia. Jeśli chcesz całkowicie wyłączyć plik z liczenia, użyj `excludePaths`.

**W trybie `markers` wszystko jest raportowane jako Human.**
Tryb znaczników liczy tylko to, co znajduje się wewnątrz bloków `AI start` / `AI stop`, i tylko te znaczniki, które są częścią Twoich dodanych zmian **w przechowalni**. Sprawdź, czy blok jest dodany do przechowalni i czy linia znacznika przetrwała usuwanie przy poprzednim commicie.

**Moje znaczniki zniknęły.**
W trybie `markers` jest to zamierzone — zobacz [Znaczniki są usuwane przy commicie](#znaczniki-są-usuwane-przy-commicie). Aby je zachować, przełącz się na tryb `signals`.

**Commit raportuje `(AI: unavailable)`.**
Zadziałał mechanizm awaryjny generowania podsumowania albo hooka. To nie jest stwierdzenie na temat użycia AI. Sprawdź kanał wyjściowy `AILoc2 Summary` lub log IDE, aby znaleźć źródłowe ostrzeżenie.

## Zobacz też

- [`attribution-and-summary.md`](attribution-and-summary.md) — jak liczona jest atrybucja w trybie sygnałów i podsumowania
- [`hooks-and-runtime.md`](hooks-and-runtime.md) — instalacja hooków i adnotowanie komunikatów commitów
- [`ownership-attribution-decision-tree.md`](ownership-attribution-decision-tree.md) — drzewo decyzyjne sygnałów
