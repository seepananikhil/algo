import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts"

export type Band = { top: number; bottom: number; fill?: string; edge?: string }

/** Full-width shaded price bands with dashed edges, drawn behind the candles. */
export class PriceBandPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null
  private requestUpdate: (() => void) | null = null
  private bands: Band[] = []
  private readonly fill = "rgba(250, 204, 21, 0.14)"
  private readonly edge = "rgba(234, 179, 8, 0.85)"

  attached({ series, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.series = series
    this.requestUpdate = requestUpdate
  }

  detached() {
    this.series = null
    this.requestUpdate = null
  }

  setBands(bands: Band[]) {
    this.bands = bands
    this.requestUpdate?.()
  }

  paneViews(): readonly IPrimitivePaneView[] {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        const s = this.series
        if (!s || !this.bands.length) return
        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vr, horizontalPixelRatio: hr }) => {
          for (const band of this.bands) {
            const y1 = s.priceToCoordinate(band.top)
            const y2 = s.priceToCoordinate(band.bottom)
            if (y1 === null || y2 === null) continue
            const top = Math.round(Math.min(y1, y2) * vr)
            const bottom = Math.round(Math.max(y1, y2) * vr)
            ctx.fillStyle = band.fill ?? this.fill
            ctx.fillRect(0, top, bitmapSize.width, bottom - top)
            ctx.strokeStyle = band.edge ?? this.edge
            ctx.lineWidth = Math.max(1, Math.round(vr))
            ctx.setLineDash([6 * hr, 4 * hr])
            for (const y of [top, bottom]) {
              ctx.beginPath()
              ctx.moveTo(0, y + 0.5)
              ctx.lineTo(bitmapSize.width, y + 0.5)
              ctx.stroke()
            }
            ctx.setLineDash([])
          }
        })
      },
    }
    return [{ zOrder: () => "bottom", renderer: () => renderer }]
  }
}
