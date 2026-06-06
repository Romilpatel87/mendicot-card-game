Sound effects for Mendicot
==========================

Drop your MP3 files in THIS folder, named exactly (lowercase):

  mendi.mp3   — plays when a team captures a 10 (mendi)
  cot.mp3     — plays when a team wins the cot (all the tens)

Tips:
  • Keep them short (about 1–3 seconds) and small (a few hundred KB).
  • Filenames must match exactly, including the .mp3 extension.
  • You can swap the files anytime — no code change needed; just commit & push.
  • Players can mute everything with the 🔊 button in the top bar.

Want more sounds later (e.g. on every trick, on win/lose)? Tell me the event
and the filename and I'll wire it up — the player just calls sfx('<name>')
which loads /sounds/<name>.mp3.
