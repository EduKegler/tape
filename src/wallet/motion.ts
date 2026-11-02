const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

type Options = KeyframeAnimationOptions & { readonly duration: number; readonly delay?: number }

/** Browsers pause animations in a hidden tab, so a flow never waits longer than the animation's own length. */
export function play(element: Element | null, keyframes: Keyframe[], options: Options): Promise<void> {
  if (!element) return Promise.resolve()
  const animation = element.animate(keyframes, { fill: 'both', easing: EASE_OUT, ...options })
  return Promise.race([
    animation.finished.then(
      () => undefined,
      () => undefined,
    ),
    sleep(options.duration + (options.delay ?? 0) + 60).then(() => {
      if (animation.playState === 'running') animation.finish()
    }),
  ])
}

function radiusOf(element: Element) {
  return Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0
}

export function morph(
  layer: Element | null,
  from: DOMRect,
  to: DOMRect,
  options: Options & { readonly back?: boolean },
) {
  if (!layer || to.width === 0 || to.height === 0) return Promise.resolve()
  const scaleX = from.width / to.width
  const scaleY = from.height / to.height
  const radius = radiusOf(layer)
  const squeezed = {
    transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scaleX}, ${scaleY})`,
    borderRadius: `${radius / scaleX}px / ${radius / scaleY}px`,
  }
  const rest = { transform: 'none', borderRadius: `${radius}px` }
  return play(layer, options.back ? [rest, squeezed] : [squeezed, rest], options)
}

export function flip(element: Element | null, first: DOMRect, options: Options) {
  if (!element) return Promise.resolve()
  const last = element.getBoundingClientRect()
  if (last.width === 0 || last.height === 0) return Promise.resolve()
  return play(
    element,
    [
      {
        transformOrigin: 'top left',
        transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`,
      },
      { transformOrigin: 'top left', transform: 'none' },
    ],
    { fill: 'none', ...options },
  )
}

export function rise(
  elements: Iterable<Element>,
  { from = 0, step, rise: lift = 6, duration = 260 }: { from?: number; step: number; rise?: number; duration?: number },
) {
  return Promise.all(
    [...elements].map((element, index) =>
      play(
        element,
        [
          { opacity: 0, transform: `translateY(${lift}px)` },
          { opacity: 1, transform: 'none' },
        ],
        {
          duration,
          delay: from + Math.min(index, 7) * step,
        },
      ),
    ),
  )
}

export const fade = (element: Element | null, to: 0 | 1, duration: number) =>
  play(element, [{ opacity: to === 1 ? 0 : 1 }, { opacity: to }], { duration, easing: 'linear' })
