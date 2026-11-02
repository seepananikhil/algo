import type {
  AutoscaleInfo,
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts"

export type TimeBoundedBox = {
  id: string
  startTime: UTCTimestamp
  endTime: UTCTimestamp
  ceiling: number
  floor: number
  midpoint: number
  rangePts: number
  durationBars: number
  status: "coiling" | "breakout_up" | "breakout_down" | "exhausted" | string
}

/**
 * Draws time-bounded rectangular compression boxes on the chart.
 * Instead of drawing across the whole screen, boxes are strictly bounded
 * between startTime and endTime on the horizontal axis, and ceiling and floor
 * on the vertical axis.
 */
export class BoxPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private series: ISeriesApi<SeriesType, Time> | null = null
  private requestUpdate: (() => void) | null = null
  private boxes: TimeBoundedBox[] = []

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time, SeriesType>) {
    this.chart = chart
    this.series = series
    this.requestUpdate = requestUpdate
  }

  detached() {
    this.chart = null
    this.series = null
    this.requestUpdate = null
  }

  setBoxes(boxes: TimeBoundedBox[]) {
    this.boxes = boxes
    this.requestUpdate?.()
  }

  autoscaleInfo(): AutoscaleInfo | null {
    const active = this.boxes.filter(
      (b) => Number.isFinite(b.ceiling) && Number.isFinite(b.floor)
    )
    if (!active.length) return null
    let minValue = Infinity
    let maxValue = -Infinity
    for (const b of active) {
      minValue = Math.min(minValue, b.floor, b.ceiling)
      maxValue = Math.max(maxValue, b.floor, b.ceiling)
    }
    return minValue <= maxValue ? { priceRange: { minValue, maxValue } } : null
  }

  paneViews(): readonly IPrimitivePaneView[] {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        const c = this.chart
        const s = this.series
        if (!c || !s || !this.boxes.length) return

        target.useBitmapCoordinateSpace(
          ({ context: ctx, verticalPixelRatio: vr, horizontalPixelRatio: hr }) => {
            const timeScale = c.timeScale()

            for (const b of this.boxes) {
              const x1Coord = timeScale.timeToCoordinate(b.startTime)
              const x2Coord = timeScale.timeToCoordinate(b.endTime)
              const yCeil = s.priceToCoordinate(b.ceiling)
              const yFloor = s.priceToCoordinate(b.floor)
              const yMid = s.priceToCoordinate(b.midpoint)

              if (yCeil === null || yFloor === null) continue

              // Coordinate conversion
              const top = Math.round(Math.min(yCeil, yFloor) * vr)
              const bottom = Math.round(Math.max(yCeil, yFloor) * vr)
              const height = Math.max(bottom - top, 2)

              // If x1 or x2 are off-screen, clamp gracefully
              let xLeft = x1Coord !== null ? Math.round(x1Coord * hr) : 0
              let xRight = x2Coord !== null ? Math.round(x2Coord * hr) : xLeft + Math.round(40 * hr)

              if (xLeft > xRight) {
                const tmp = xLeft
                xLeft = xRight
                xRight = tmp
              }

              // Minimum visible width for short boxes
              const width = Math.max(xRight - xLeft, Math.round(14 * hr))

              // Color styling based on box state
              let fillColor = "rgba(234, 179, 8, 0.12)"   // warm amber fill
              let edgeColor = "rgba(234, 179, 8, 0.85)"   // amber border
              let badgeColor = "#eab308"

              if (b.status === "breakout_up") {
                fillColor = "rgba(16, 185, 129, 0.12)"
                edgeColor = "rgba(16, 185, 129, 0.85)"
                badgeColor = "#10b981"
              } else if (b.status === "breakout_down") {
                fillColor = "rgba(239, 68, 68, 0.12)"
                edgeColor = "rgba(239, 68, 68, 0.85)"
                badgeColor = "#ef4444"
              } else if (b.status === "coiling") {
                fillColor = "rgba(56, 189, 248, 0.14)"
                edgeColor = "rgba(56, 189, 248, 0.90)"
                badgeColor = "#38bdf8"
              }

              // 1. Draw Shaded Rectangle (strictly between xLeft and xRight)
              ctx.fillStyle = fillColor
              ctx.fillRect(xLeft, top, width, height)

              // 2. Draw Dashed Box Borders
              ctx.strokeStyle = edgeColor
              ctx.lineWidth = Math.max(1, Math.round(1.5 * vr))
              ctx.setLineDash([5 * hr, 3 * hr])
              ctx.strokeRect(xLeft, top, width, height)

              // 3. Draw Dotted Midpoint Line inside the box
              if (yMid !== null) {
                const midY = Math.round(yMid * vr)
                if (midY >= top && midY <= bottom) {
                  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)"
                  ctx.lineWidth = Math.max(1, Math.round(1 * vr))
                  ctx.setLineDash([2 * hr, 3 * hr])
                  ctx.beginPath()
                  ctx.moveTo(xLeft, midY + 0.5)
                  ctx.lineTo(xLeft + width, midY + 0.5)
                  ctx.stroke()
                }
              }
              ctx.setLineDash([])

              // 4. Draw Neat Title Badge on Top-Left of Box
              const text = `${Math.round(b.ceiling)} - ${Math.round(b.floor)} (${b.rangePts.toFixed(1)} pts · ${b.durationBars}m)`
              ctx.font = `${Math.round(10 * vr)}px Geist Mono, monospace, sans-serif`
              const textWidth = ctx.measureText(text).width
              const padX = Math.round(4 * hr)
              const badgeH = Math.round(14 * vr)
              const badgeY = Math.max(top - badgeH - 2, 0)

              // Badge background
              ctx.fillStyle = "rgba(0, 0, 0, 0.75)"
              ctx.fillRect(xLeft, badgeY, textWidth + padX * 2, badgeH)
              ctx.strokeStyle = badgeColor
              ctx.lineWidth = 1
              ctx.strokeRect(xLeft, badgeY, textWidth + padX * 2, badgeH)

              // Badge text
              ctx.fillStyle = badgeColor
              ctx.fillText(text, xLeft + padX, badgeY + Math.round(10 * vr))
            }
          }
        )
      },
    }
    return [{ zOrder: () => "bottom", renderer: () => renderer }]
  }
}
