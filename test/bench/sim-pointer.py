#!/usr/bin/env python3
# OS mouse events for the iOS Simulator window (macOS, needs pyobjc's Quartz): the Simulator turns a mouse drag into a touch drag, with the release velocity
# giving a momentum (inertial) scroll, which WebDriver cannot produce (a touch pointer move wedges safaridriver on the simulator).
#   sim-pointer.py bounds                       -> JSON bounds of the Simulator's device window (screen points)
#   sim-pointer.py click X Y                    -> one click at screen point (X, Y)
#   sim-pointer.py drag X1 Y1 X2 Y2 MS [STEPS]  -> press at 1, drag to 2 over MS milliseconds, release (a flick when MS is short)
#   sim-pointer.py park                         -> move the pointer to the top-left corner of the main display
import json, sys, time
import Quartz as Q


def post(kind, x, y):
    ev = Q.CGEventCreateMouseEvent(None, kind, (x, y), Q.kCGMouseButtonLeft)
    Q.CGEventPost(Q.kCGHIDEventTap, ev)


def bounds():
    wins = Q.CGWindowListCopyWindowInfo(Q.kCGWindowListOptionOnScreenOnly, Q.kCGNullWindowID)
    best = None
    for w in wins:
        if w.get('kCGWindowOwnerName') != 'Simulator' or w.get('kCGWindowLayer') != 0:
            continue
        b = w['kCGWindowBounds']
        if best is None or b['Width'] * b['Height'] > best['Width'] * best['Height']:
            best = b
    return None if best is None else {'x': best['X'], 'y': best['Y'], 'width': best['Width'], 'height': best['Height']}


cmd = sys.argv[1]
if cmd == 'bounds':
    print(json.dumps(bounds()))
elif cmd == 'click':
    x, y = float(sys.argv[2]), float(sys.argv[3])
    post(Q.kCGEventMouseMoved, x, y); time.sleep(0.05)
    post(Q.kCGEventLeftMouseDown, x, y); time.sleep(0.06)
    post(Q.kCGEventLeftMouseUp, x, y)
elif cmd == 'drag':
    x1, y1, x2, y2, ms = map(float, sys.argv[2:7])
    steps = int(sys.argv[7]) if len(sys.argv) > 7 else 12
    post(Q.kCGEventMouseMoved, x1, y1); time.sleep(0.05)
    post(Q.kCGEventLeftMouseDown, x1, y1); time.sleep(0.03)
    for i in range(1, steps + 1):
        post(Q.kCGEventLeftMouseDragged, x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
        time.sleep(ms / 1000 / steps)
    post(Q.kCGEventLeftMouseUp, x2, y2)
elif cmd == 'park':
    post(Q.kCGEventMouseMoved, 2, 2)
