# The 3D visual check

This is the step people skip and shouldn't. After every geometry operation,
render the actual 3D scene and *look* at it — yourself and with a vision model.

## Render several angles
`mc_render_3d(masks, landmarks, lines, out_path, angles=[...])` produces
marching-cubes surfaces (bones translucent, growth plate opaque), landmark
points, and measurement lines, from a set of camera angles (front / oblique /
side / top). One angle hides errors — a point that looks on-surface from the
front can be floating when seen from the side. Use ≥3 angles.

Render solidity matters for the check: keep enough triangles (don't over-
decimate) and use moderate opacity (~0.55 for bone) so the shape reads as a
surface, not a faint cloud.

## Vision critique
`mc_vision_check(image_paths, anatomy_prompt, measurements, llm)` sends the
renders to a vision model with a prompt that (a) describes the anatomy and what
each colored line/point should be, (b) asks for a per-line verdict on whether it
is placed correctly and exactly what is wrong if not, and (c) ends with
`VERDICT: PASS` or `VERDICT: NEEDS-CORRECTION`. Pass the reported measurement
values too, so the model can sanity-check magnitudes.

Prompt-writing tips: state the color→structure mapping explicitly ("pink =
femur, the upper bone; it splits distally into two condyles"), and ask for
specifics ("a condyle dot sits on the shaft above the articular surface", "the
width line runs front-to-back instead of side-to-side"), not a vague thumbs-up.

## Honest limits — a PASS is evidence, not proof
The matplotlib 3D renderer has **weak depth cues**: translucent triangle meshes
with imperfect depth-sorting. A landmark that is actually ~1–2 mm off in depth
can look on-surface, and a vision model reading that render will happily return
PASS. So:
- Treat a PASS as *supporting* evidence alongside the numeric `assess_placement`
  check and slice-by-slice 2D verification — not as final sign-off.
- When the vision model and your own numbers disagree, trust the numbers and say
  so. (On the OA sample, the vision model called femur-width endpoints "at the
  articular surface" when the quantitative check showed they were ~1.5 mm
  proximal of it — the render couldn't show the depth error.)
- A proper interactive renderer (Plotly in the review HTML, or a real 3D viewer)
  gives the human the depth control the static render lacks — which is why the
  end state is auto-propose + human review, not full automation.

Kaleido/Chrome-based static export of Plotly scenes needs a working browser,
which a headless sandbox usually lacks — fall back to matplotlib 3D for the
self-check renders, and deliver Plotly as interactive HTML for the human.

## Close the loop
If the check flags a line, go back to `landmarks.md` (re-pick on the correct
slice / common plane) or to the parameters, fix, and **re-render**. The value of
the check is only realized when it drives a correction and you confirm the next
render is clean.
