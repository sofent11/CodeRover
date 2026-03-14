1. Fix Gesture Interception
   - Update `Modifier.draggable` to only allow dragging from the left edge of the screen when `isSidebarOpen` is false. This prevents intercepting horizontal scroll elsewhere in the app. We can do this by using `PointerInput` directly or checking `sidebarDragOffset` contextually, but actually a better way is to use Compose's `swipeable` or implement edge detection in a custom pointer input gesture. Given the `draggable` modifier is used, we can restrict its usage or state based on the drag start position. Let's replace `draggable` with a custom `pointerInput(Unit)` that detects horizontal drag, but only accepts it if it starts on the left edge (e.g., `x < 30.dp` or similar), mimicking iOS edge swipe.
2. Fix Laggy Drag Animation
   - Don't use `animateFloatAsState` for the raw drag value. The animation should only apply to the target snapping offset, not the continuous drag offset. We can structure it such that the offset is: `animatedSnapOffset + dragOffset`. Or we just run a coroutine with `Animatable` to snap open/closed, and update its value directly during drag.
3. Build & Test
   - Run build and tests.
4. Request Code Review
   - Make sure no regressions are introduced.
