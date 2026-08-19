# PrettyCAS

There is lots of powerful software out there to solve general purpose math problems but in my opinion it all has shortcomings. Wolfram Alpha is very powerful but has a very crusty interface to put in maths and also can have finicky syntax (maybe by being too smart), Symbolab has also been pretty good, having a nice balance between a nice front-end UI to type interactive equations into and a decent engine, however it still isn't perfect. So I attempted to make something that does both.

The goal is for it to seem like you are using an equation editor that is super easy and intuitive to interact with (similar to MS Word where natural typing habits are picked up on, fortunately someone has made something exactly like this called MathLive and so I have to do no hard work). MathLive can output MathJSON which is a nice tree style structure to fit mathematical expressions, and with the help of AI a Python backend will take in the MathJSON from the input and feed it into the SymPy library which again makes my job easy. The Python backend then sends the result to the frontend for it to be displayed.

To use MathLive it needed to be a web interface anyway so I got carried away and told the AI to add lots of effects like matrix rain and make it look really cool, but really the goal is combining the two projects of MathLive and SymPy to have a powerful calculator app. I also let the AI have a shot at doing plotting for convenience and I tried to get it to be nice but it's just there for convenience, it's not really what I made the project for.

I am not a programmer, I made this project in a weekend because I wanted a good calculator, yes it's pretty much all AI, use the project if you want otherwise don't.

## Screenshots

Same system, exact vs. decimal:

| Standard | Decimal |
|---|---|
| ![Standard mode](Photos/Standard.png) | ![Decimal mode](Photos/Decimal.png) |

Complex evaluation:

![Complex evaluation](Photos/complex.png)

Integrating in terms of an abstract function:

![Integral of an abstract function](Photos/Integral.png)

3D plotting:

![3D plot](Photos/Plotting.png)

## Functionality

- Basic computation and simplification (standard/expand/factor, exact or decimal, engineering notation)
- Complex numbers
- Matrices (determinant, inverse, solving for an unknown matrix)
- Algebra - closed-form (CAS) solving, falls back to numeric if unsolvable
- Equations, systems of equations (`{ }` syntax), and inequalities
- Integrals (definite/indefinite)
- Derivatives
- Limits
- Summation
- Products
- ODEs
- Systems of ODEs
- 2D/3D plotting - implicit or explicit, log scaling, custom colour maps, export to SVG/PDF/EPS/PNG
- Session **Workspace** (`d = 5` remembered for later inputs) and persistent **History**
- **Help** page that self-tests its examples live against the running backend
- **Misc** page - coming soon (eigenvalues, cross-correlation, convolution, moving averages)

## How it works
### Compute
- You type an equation into a MathLive field; the browser converts it to MathJSON.
- The frontend POSTs that MathJSON to the Flask backend (`/api/compute`), which turns it into a SymPy expression.
- Results come back as both plain text and LaTeX, rendered back into the page.
- A session-only **Workspace** panel lets you save variables e.g. `b = 2` and reuse `b` in later inputs; **History** persists past inputs across restarts (Workspace doesn't).
### Plot
- The Plot page samples an expression over a domain server-side (`/api/sample`) and draws it with Plotly; there is a crusty export option which will use matplotlib to save the plot.
- Can do 2D and 3D, implicit or explicit; 2D allows log scaling and 3D can have a custom colour map, but don't expect a whole lot, the goal is to be similar to Desmos.

## Installation

Builds with PyInstaller and installs a launchable app (Start Menu / app launcher entry), user-local, no admin/sudo required. Re-run the install script any time after changing source.

### Quick start (any OS)

Once the venv + package install steps below are done, you don't need to build/install anything to just run it:
```bash
cd backend
.venv/bin/python desktop.py
```
(Windows: `.venv\Scripts\python desktop.py`)

This opens PrettyCAS in a native window directly. The Linux/Windows steps below are only for getting a permanent Start Menu / app-launcher entry.

### Linux

Make python virtual environment in repo
```bash
python3 -m venv backend/.venv
```

Install packages
```bash
backend/.venv/bin/pip install -r backend/requirements.txt
cd frontend && npm install && cd ..
```

Run install script
```bash
./install-linux.sh
```

### Windows

Make python virtual environment in repo
```powershell
python -m venv backend\.venv
```

Install packages
```powershell
backend\.venv\Scripts\pip install -r backend\requirements.txt
cd frontend; npm install; cd ..
```

Run install script
```powershell
powershell -ExecutionPolicy Bypass -File install-windows.ps1
```

## Layout

- `backend/app.py`  Flask routes (`/api/compute`, `/api/sample`, `/api/export`) and static frontend serving.
- `backend/desktop.py`  desktop entry point (runs the Flask server + a pywebview window).
- `backend/functions/`  MathJSON -> SymPy conversion, compute dispatch, solvers, plot sampling/export.
- `frontend/`  the UI: `index.html`/`app.js` (Compute), `plot.html`/`plot.js` (Plot), `help.html`/`help.js` (Help, self-tests its examples against the live backend), `misc.html`/`misc.js` (Misc, placeholder).
- `prettycas.spec`  PyInstaller build spec. Swap `icon.svg`/`icon.png`/`icon.ico` (same filenames) to rebrand.
