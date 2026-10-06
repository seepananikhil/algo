import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts"

type Band = { top: number; bottom: number } | null

/** Full-width shaded price band with dashed edges, drawn behind the candles. */
export class PriceBandPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null
  private requestUpdate: (() => void) | null = null
  private band: Band = null
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

  setBand(band: Band) {
    this.band = band
    this.requestUpdate?.()
  }

  paneViews(): readonly IPrimitivePaneView[] {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        const s = this.series
        if (!s || !this.band) return
        const y1 = s.priceToCoordinate(this.band.top)
        const y2 = s.priceToCoordinate(this.band.bottom)
        if (y1 === null || y2 === null) return
        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vr, horizontalPixelRatio: hr }) => {
          const top = Math.round(Math.min(y1, y2) * vr)
          const bottom = Math.round(Math.max(y1, y2) * vr)
          ctx.fillStyle = this.fill
          ctx.fillRect(0, top, bitmapSize.width, bottom - top)
          ctx.strokeStyle = this.edge
          ctx.lineWidth = Math.max(1, Math.round(vr))
          ctx.setLineDash([6 * hr, 4 * hr])
          for (const y of [top, bottom]) {
            ctx.beginPath()
            ctx.moveTo(0, y + 0.5)
            ctx.lineTo(bitmapSize.width, y + 0.5)
            ctx.stroke()
          }
          ctx.setLineDash([])
        })
      },
    }
    return [{ zOrder: () => "bottom", renderer: () => renderer }]
  }
}
