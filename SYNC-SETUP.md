# הקמת סנכרון אוטומטי (Auto-Sync) במחשב חדש

המערכת שומרת על הקוד מסונכרן בין כמה מחשבים דרך GitHub.
כל מחשב **דוחף** את השינויים שלו ו**מושך** את של האחרים, אוטומטית.

> מנגנון: הסקריפט `sync-repo.bat` מבצע `commit` → `pull --rebase` → `push`.
> משימה מתוזמנת בשם `PlantsTracker-GitSync` מריצה אותו כל יום ב-09:00.

---

## להקמה במחשב חדש — 4 שלבים

### 1. שכפול הריפו (clone)
```powershell
cd "C:\Users\<שם המשתמש>\Documents\js coding"
git clone https://github.com/gopalMasaya/BW_berries.git plantsTracker
cd plantsTracker
```

### 2. חיבור GitHub CLI עם הרשאת workflow ⚠️ קריטי
בלי הרשאת `workflow` ה-push ייחסם (יש בריפו קובץ GitHub Action).
```powershell
gh auth login          # אם gh עדיין לא מחובר בכלל
gh auth refresh -h github.com -s workflow
```
> הריצו בחלון PowerShell אמיתי (לא מתוך Claude). יופיע קוד חד-פעמי →
> פתחו https://github.com/login/device → הדביקו → Authorize.
> אימות: `gh auth status` צריך להראות scope בשם `workflow`.

### 3. עדכון הנתיב בתוך הסקריפט
ערכו את `sync-repo.bat` ושנו את שורת ה-`cd /d` לנתיב המלא של התיקייה במחשב הזה.

### 4. יצירת המשימה המתוזמנת
```powershell
schtasks /create /tn "PlantsTracker-GitSync" /tr "\"C:\<נתיב מלא>\plantsTracker\sync-repo.bat\"" /sc DAILY /st 09:00 /f
```
(להוספת טריגר "בכניסה למחשב" צריך PowerShell עם הרשאות מנהל.)

---

## קובץ סוד שלא מסתנכרן 🔑
`plantstracker-f1274-firebase-adminsdk-*.json` נמצא ב-`.gitignore` ולא עולה לגיטהב.
אם הקוד במחשב הזה צריך אותו — העתיקו אותו ידנית (USB/כונן מאובטח) פעם אחת.

---

## שימוש יומיומי
- **סנכרון ידני מיידי:** הריצו פעמיים-לחיצה על `sync-repo.bat`.
- **לוג:** מתי רצו סנכרונים נרשם ב-`sync-log.txt`.
- **תדירות:** ברירת המחדל פעם ביום ב-09:00. לשינוי — ערכו את המשימה ב-Task Scheduler.
- **קונפליקט:** אם עורכים את אותו קובץ בשני מחשבים לפני סנכרון, ה-rebase עלול לעצור וה-push ייכשל — פתרו ידנית (`git status`).
