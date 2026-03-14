<<<<<<< SEARCH
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.animation.core.animateFloatAsState
=======
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.input.pointer.pointerInput
import kotlinx.coroutines.launch
>>>>>>> REPLACE
<<<<<<< SEARCH
    val targetOffset = if (isSidebarOpen) {
        max(0f, effectiveSidebarWidthPx + sidebarDragOffset)
    } else {
        max(0f, sidebarDragOffset)
    }

    val animatedOffset by animateFloatAsState(
        targetValue = targetOffset,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.85f),
        label = "sidebarOffset"
    )

    val draggableState = rememberDraggableState { delta ->
        if (!isSidebarOpen) {
            sidebarDragOffset = max(0f, sidebarDragOffset + delta)
        } else {
            sidebarDragOffset = min(0f, sidebarDragOffset + delta)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .draggable(
                state = draggableState,
                orientation = Orientation.Horizontal,
                onDragStopped = { velocity ->
                    val threshold = effectiveSidebarWidthPx * 0.4f
                    if (!isSidebarOpen) {
                        if (sidebarDragOffset > threshold || velocity > 1000f) {
                            isSidebarOpen = true
                        }
                    } else {
                        if (-sidebarDragOffset > threshold || velocity < -1000f) {
                            isSidebarOpen = false
                        }
                    }
                    sidebarDragOffset = 0f
                }
            )
    ) {
=======
    val animatedOffset = remember { Animatable(0f) }

    LaunchedEffect(isSidebarOpen, effectiveSidebarWidthPx) {
        val target = if (isSidebarOpen) effectiveSidebarWidthPx else 0f
        animatedOffset.animateTo(
            targetValue = target,
            animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.85f)
        )
    }

    val edgeDragWidthPx = with(density) { 30.dp.toPx() }
    var dragStartedValidly by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(isSidebarOpen, effectiveSidebarWidthPx) {
                detectHorizontalDragGestures(
                    onDragStart = { offset ->
                        dragStartedValidly = isSidebarOpen || offset.x < edgeDragWidthPx
                    },
                    onDragEnd = {
                        if (!dragStartedValidly) return@detectHorizontalDragGestures
                        coroutineScope.launch {
                            val threshold = effectiveSidebarWidthPx * 0.4f
                            val currentOffset = animatedOffset.value
                            if (!isSidebarOpen) {
                                if (currentOffset > threshold) {
                                    isSidebarOpen = true
                                } else {
                                    animatedOffset.animateTo(0f, spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.85f))
                                }
                            } else {
                                if (effectiveSidebarWidthPx - currentOffset > threshold) {
                                    isSidebarOpen = false
                                } else {
                                    animatedOffset.animateTo(effectiveSidebarWidthPx, spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.85f))
                                }
                            }
                        }
                    },
                    onDragCancel = {
                        if (!dragStartedValidly) return@detectHorizontalDragGestures
                        coroutineScope.launch {
                            animatedOffset.animateTo(
                                targetValue = if (isSidebarOpen) effectiveSidebarWidthPx else 0f,
                                animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.85f)
                            )
                        }
                    },
                    onHorizontalDrag = { change, dragAmount ->
                        if (!dragStartedValidly) return@detectHorizontalDragGestures
                        change.consume()
                        coroutineScope.launch {
                            val newOffset = max(0f, min(effectiveSidebarWidthPx, animatedOffset.value + dragAmount))
                            animatedOffset.snapTo(newOffset)
                        }
                    }
                )
            }
    ) {
>>>>>>> REPLACE
<<<<<<< SEARCH
        // Main App Content Layer
        Box(
            modifier = Modifier
                .fillMaxSize()
                .offset { IntOffset(animatedOffset.roundToInt(), 0) }
        ) {
=======
        // Main App Content Layer
        Box(
            modifier = Modifier
                .fillMaxSize()
                .offset { IntOffset(animatedOffset.value.roundToInt(), 0) }
        ) {
>>>>>>> REPLACE
<<<<<<< SEARCH
            // Dim Layer for Main Content when Sidebar is open
            if (isSidebarOpen || sidebarDragOffset > 0) {
                val progress = min(1f, animatedOffset / effectiveSidebarWidthPx)
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            color = MaterialTheme.colorScheme.scrim.copy(alpha = 0.08f * progress)
                        )
                        .clickable(
                            interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                            indication = null
                        ) {
                            isSidebarOpen = false
                            sidebarDragOffset = 0f
                        }
                )
            }
=======
            // Dim Layer for Main Content when Sidebar is open
            if (isSidebarOpen || animatedOffset.value > 0f) {
                val progress = min(1f, animatedOffset.value / effectiveSidebarWidthPx)
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            color = MaterialTheme.colorScheme.scrim.copy(alpha = 0.08f * progress)
                        )
                        .clickable(
                            interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                            indication = null
                        ) {
                            isSidebarOpen = false
                        }
                )
            }
>>>>>>> REPLACE
