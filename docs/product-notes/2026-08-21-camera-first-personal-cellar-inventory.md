# Product Discovery Notes — Camera-First Personal Cellar Inventory

Captured: 2026-08-21 08:48 PDT
Context: Live Terroir demo feedback
Status: Discovery input; not yet approved for implementation

## Core need

Make inventorying a personal wine collection camera-first rather than requiring every bottle to be entered manually.

The user should be able to photograph a cellar location—wine cellar, rack, refrigerator, bin, or case—and receive a visual rendering or structured representation of that storage area and its contents.

## Fast bottle-capture loop

1. Take a photo of a bottle or label.
2. Identify the wine from the wine database.
3. Present a fast confirmation step for the producer/wine and vintage.
4. Let the user accept or correct the match.
5. Log the confirmed bottle into the selected storage location.
6. Return immediately to the camera for the next bottle.

The desired interaction is: photograph → identify → confirm → log → repeat.

## Storage-location model

Inventory should support the real physical organization of a personal cellar:

- cellars and rooms;
- racks and rack positions;
- wine refrigerators;
- bins;
- six-packs and twelve-packs;
- unopened cases, including original wooden cases.

A photograph of a rack, refrigerator, or bin should help create or update a spatial representation of that location rather than producing only an unlocated bottle record.

## Unopened and long-term cases

Collectors may intentionally leave wine sealed in original cases for 10–20 years. Terroir should let the case remain a first-class stored object while still showing what is expected to be inside it.

Potential behavior:

- infer or reconcile case contents from purchase history;
- record producer, wine, vintage, format, and expected bottle count;
- show the case's physical storage location without requiring it to be opened;
- distinguish expected contents from visually verified contents;
- support partial cases later without losing provenance.

## Personal versus restaurant use

Personal collectors have needs that differ from restaurant operations:

- purchases may be stored untouched for many years;
- wine may be reserved for a future occasion or as a gift;
- remembering which case contains a purchase becomes difficult over time;
- preservation of original packaging can matter more than bottle-level handling speed.

The product may need an explicit personal-collection mode or a shared foundation with workflows tailored separately for collectors and restaurants.

## Important product principles

- Minimize typing during initial inventory.
- Make the confirmation action fast and thumb-friendly.
- Never silently treat an uncertain visual match as verified.
- Preserve provenance: photo evidence, purchase record, user confirmation, and later physical verification should remain distinguishable.
- Model physical containers and locations, not just a flat bottle list.

## Follow-up questions

1. Should the first photo capture an entire rack/bin, individual labels, or both in a guided sequence?
2. What confidence threshold permits one-tap acceptance versus requiring correction?
3. Should purchase records pre-populate expected unopened cases before any photograph is taken?
4. How should mixed, partial, damaged, or opened cases be represented?
5. Should the rendering be a photo overlay, rack grid, 3D view, or simpler visual map?
6. What personal-collection privacy and sharing permissions are required?
7. The source note ended with an incomplete thought about granting access; clarify who should receive access and to what.
