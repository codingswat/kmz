# KML / KMZ Point Extractor

Desktop app that pulls every point and every area out of KML and KMZ files,
converts each one into five coordinate formats, measures each area, and writes
the whole batch to a single Excel workbook.

## Install

Python 3.10+ required.

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[gui]"
```

On Linux, tkinter is a separate system package:

```bash
sudo apt install python3-tk      # Debian/Ubuntu
```

## Run

```bash
python run.py
```

Drag KML/KMZ files onto the drop zone, or use **Browse** to pick several at
once. Each file appears with its point count; select any and **Remove
selected** to drop them. The output folder defaults to the folder of the first
file you added. **Export to Excel** writes the workbook and reports what it
did.

There is also a headless CLI, which is what the end-to-end tests drive:

```bash
python -m kmz_points.cli file1.kml file2.kmz -o /path/to/output
python -m kmz_points.cli --make-samples samples/     # generate demo inputs
```

There is also a small LAN web service, for colleagues who would rather use a
browser than install the app — see
[BUILDING.md](BUILDING.md#running-the-service-for-colleagues) for how to
start it.

## Output

One workbook per batch, named `points_YYYYMMDD_HHMM.xlsx`, one row per point,
in 24 columns grouped into five labelled bands:

| Band | Columns |
|---|---|
| name | Name |
| separation (decimal degrees) | longitude, latitude, elevation |
| Combined D,M,S | #, longitude, latitude |
| separated D,M,S | lat, D, M, S, long, D, M, S |
| details | Description, Attributes, Lat (DDM), Lon (DDM), UTM Zone, Easting (m), Northing (m), MGRS, Source File |

`Name` leads the table on both sheets: it is what a reader scans for, and a
row is far easier to find by its name than by its longitude.

The sheet has three header rows above the data: a merged title per band, a
merged caption beneath it (only "separation" has one, captioned "decimal
degrees" — every other band's title just claims both rows instead), then the
column names on the third row. Data starts on row 4, and the sheet is frozen
below all three header rows so they stay in view while scrolling. A grey
banner spanning every column names each source file, directly above its group
of rows — including when the batch came from a single file.

The band titles and the column names are bold; the caption row is not. Column
widths are fitted to content.
`longitude`, `latitude`, `elevation`, `#`, the numeric `lat`/`long` columns
and their `D`/`M`/`S` breakdowns, `Easting (m)` and `Northing (m)` are stored
as real numbers so they sort and work in formulas; the combined D,M,S text,
`Name`, `Description`, `Attributes`, the DDM columns, `UTM Zone`, `MGRS` and
`Source File` are formatted text.

#### D, M, S are magnitudes, not signed values

The separated `D`, `M` and `S` columns hold whole degrees, whole minutes and
seconds as positive magnitudes — the sign is deliberately not carried there.
Whole degrees alone cannot express it for a value between -1 and 0: a
latitude of `-0.180653` is south, but its whole-degree part is `0`, and `0`
has no sign either way. Each D/M/S triple sits beside the signed decimal
value it was split from — the `lat`/`long` column immediately to its
left — and that repeated decimal is what actually carries the hemisphere.

### Coordinate formats

| Format | Example |
|---|---|
| Decimal degrees | `34.567890` |
| Degrees decimal minutes | `34° 34.0734' N` |
| Degrees minutes seconds | `34° 34' 4.40" N` |
| UTM | `37S 419595 E 3825474 N` |
| MGRS | `37SDU1959425474` |

In the UTM zone, the trailing letter is the **latitude band** (`37S` is band S,
not "south"). Rounding carries between units, so no output ever reads
`60.0000'` or `60.00"`.

UTM and MGRS are left blank for points where they are undefined — beyond
84°N or 80°S. Every other column is still filled for those rows.

### The Areas sheet

A batch containing any `<Polygon>` gains a second sheet, `Areas`, using the
same columns as `Points` — a corner is a point that happens to belong to a
shape, so it carries every coordinate format too.

Each area is a grey banner giving its name, its size in all three units, the
distance round its outline and its corner count, followed by its outline's
corners as rows. A hole cut out of the shape gets a lighter sub-banner and its
own corners beneath it. Corner numbering restarts within each ring.

```
An area — 957,503 m² · 95.750 ha · 0.957503 km² · 3,996 m perimeter · 4 corners
hole 1 — 4 corners
```

Sizes are **flat map area** — the shape as traced on a map, not surface area
following the terrain. A sloping hillside's true surface is larger than its
footprint, and the elevation data needed for that is not in a KML.

Measurement is on the WGS-84 ellipsoid itself. Area comes from the spherical
excess on the authalic sphere — the sphere with the same surface area as the
ellipsoid — and the perimeter from a Vincenty inverse along each edge. Holes
are subtracted from the area; the perimeter is the outline's own length,
because a hole is a second fence rather than part of the first.

> **Every area number changed when this landed.** Areas used to be measured
> by forcing every corner into one UTM zone and applying the shoelace formula,
> which cost up to 0.2% and refused anything polar or wider than a zone. Every
> area in a new workbook therefore differs slightly from the same area in an
> old one — about 0.07% on a typical parcel, and always toward the true
> figure. It is not a bug, and old workbooks are not worth reconciling against
> new ones. Two other things moved with it: polar shapes and shapes up to 10°
> across are measured now where they used to be refused, and self-intersecting
> outlines are refused now where they used to be measured.

Some shapes cannot be measured and say so on the banner instead of showing a
number:

| The banner says | What it means |
|---|---|
| needs at least 3 distinct corners | an outline that encloses nothing |
| has a corner that is not a place on Earth | a latitude past a pole, a longitude past the antimeridian, or a coordinate that is not a number |
| is larger than any plot this tool is meant to measure | the outline's bounding box is over 10° across, which in practice means a mis-keyed coordinate |
| its outline crosses itself | a bowtie or a doubled-back spike, where the enclosed area is not the area of anything |
| has a hole that cannot be measured | any of the above, in a hole. The whole shape is refused rather than reporting it as larger than it is |
| its holes cover the whole shape | nothing is left to measure |

The first four are checked on holes as well as on the outline. Whether a hole
actually falls inside the outline is not checked.

### The Issues sheet

If any file in the batch could not be read, a third sheet, `Issues`, names each
failure. It exists so the web service can report a partial failure — there the
response body is the workbook itself, with nowhere else to put a message.

## What gets extracted

Every `<Placemark>` containing a `<Point>` or a `<Polygon>`, at any folder
depth, including those inside a `<MultiGeometry>`. KML 2.2, the legacy Google
Earth namespaces, and namespace-less files all work.

`LineString`, `Model` and `Track` features are not extracted, but they are
counted and reported as *"N non-point features skipped"*.

Descriptions are converted from CDATA/HTML to a single line of plain text.

### The Attributes column

Google My Maps and most GIS tools put a placemark's real attributes in
`<ExtendedData>` rather than in its description. Both of the forms they write
are read, and both are keyed on the `name` **attribute** — a `<Data>` may also
carry a `<displayName>`, but that is presentation and two fields may share
one, so it makes a poor key:

```xml
<ExtendedData><Data name="owner"><value>Ada</value></Data></ExtendedData>
<ExtendedData><SchemaData><SimpleData name="owner">Ada</SimpleData></SchemaData></ExtendedData>
```

All of a placemark's pairs go into one cell, in the order the file lists them,
as `key=value` joined with `; ` — so the whole row stays one row:

```
owner=Ada; plot_id=A-12; surveyed=2026-03-14
```

A value may itself contain a semicolon or an equals sign, which would
otherwise read as a pair boundary that is not there. So `\`, `=` and `;` are
escaped with a backslash, and tabs and newlines become a single space. Two
different sets of attributes can never produce the same cell.

Untyped vendor children — `<ExtendedData><ex:cost>42</ex:cost></ExtendedData>`
— are deliberately **not** read: there is no agreed key for them, and it would
put arbitrary XML in a spreadsheet cell. A placemark with no `ExtendedData`
leaves the cell empty.

An area's corners carry the area's attributes, so the column is filled on the
Areas sheet too.

### Failure handling

Nothing aborts a batch. A corrupt file, a KMZ with no KML inside, a file with
zero points, or a malformed coordinate produces a warning and is skipped; every
other file still exports.

The output folder must already exist. A hand-typed path that does not is
reported before anything is written, rather than being created silently and
leaving the workbook somewhere you would not think to look.

## Tests

```bash
pytest
```

409 tests. The GUI tests need a display and skip without one; on a headless
machine run them under Xvfb:

```bash
xvfb-run -a pytest
```

### PC tester

The PC tester (the owner's Windows PC, running this repo's tests unattended) tests every branch pushed under `ci/`:

```bash
git push origin HEAD:ci/my-change
```

Within a few minutes, for commits under 48 hours old, one result file per commit lands on the `ci-results` branch, in `results/<day>-<first 8 characters of the commit>.md`: GREEN or RED, the commands, and the last lines of their output. It runs `pip install -e ".[gui,web,dev]"`, then `python -m pytest -q` under a virtual display, the web tests (`node --test "web/test/*.test.mjs"`) and `mypy kmz_points/`; the one real-Chrome check is skipped there (no Chrome).

## Layout

| Path | Purpose |
|---|---|
| `kmz_points/convert.py` | Coordinate formatting — pure functions |
| `kmz_points/archive.py` | KMZ → KML bytes |
| `kmz_points/kml_parser.py` | Placemark point and polygon extraction |
| `kmz_points/models.py` | Shared types: `Point`, `Area`, `BatchSummary` |
| `kmz_points/geometry.py` | Area measurement — pure functions |
| `kmz_points/table.py` | `COLUMNS` + `build_table_rows()` |
| `kmz_points/excel.py` | Workbook writer |
| `kmz_points/pipeline.py` | Orchestration and batch summary |
| `kmz_points/cli.py` | Headless entry point |
| `kmz_points/gui.py` | tkinter shell |
| `kmz_points/server.py` | Flask LAN web service |
| `serve.py` | Launches the web service, prints the URL to share |
| `kmz_points/samples.py` | Demo input generation |
| `kmz_points/selftest.py` | End-to-end check for a frozen build |

The column layout is defined once, in `COLUMNS`. Adding or re-ordering a
column is a change to that list and nothing else.

## Licence

MIT — see [LICENSE](LICENSE). Use it, change it, ship it; it comes with no
warranty.
