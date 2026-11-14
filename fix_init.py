import re, shutil
shutil.copy("game.js", "game.js.bak")
s = open("game.js", encoding="utf-8").read()

start_marker = "// ================= init ================="
end_marker = "// ================= Phase 3: home attract-mode ================="
a = s.index(start_marker)
b = s.index(end_marker)
block = s[a:b]
assert "refreshHome();" in block and "attractStart();" in block
assert len(block) < 1200, "init block is bigger than expected: " + str(len(block))

s = s[:a] + s[b:]

anchor = 'route();\n  window.addEventListener("load", fitCanvas);'
assert s.count(anchor) == 1, "route anchor not unique/found"
s = s.replace(anchor, block + "\n  " + anchor)

open("game.js", "w", encoding="utf-8").write(s)
print("moved", len(block), "chars")
