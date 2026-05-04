import json
data = json.load(open("/tmp/sched.json"))
for s in data.get("schedules", []):
    name = s.get("pageName", "")
    sid = s.get("id", "")
    active = s.get("isActive", False)
    segs = len(s.get("segments", []))
    print(f"{name} | id={sid} | active={active} | segs={segs}")
