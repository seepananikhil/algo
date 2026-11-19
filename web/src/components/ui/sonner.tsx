import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="top-center"
      visibleToasts={1}
      duration={1800}
      closeButton={true}
      icons={{
        success: (
          <CircleCheckIcon className="size-3.5 shrink-0" />
        ),
        info: (
          <InfoIcon className="size-3.5 shrink-0" />
        ),
        warning: (
          <TriangleAlertIcon className="size-3.5 shrink-0" />
        ),
        error: (
          <OctagonXIcon className="size-3.5 shrink-0" />
        ),
        loading: (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "10px",
          "--width": "280px",
        } as React.CSSProperties
      }
      toastOptions={{
        className: "!min-h-0 !py-1.5 !px-3 !text-xs !shadow-md !rounded-xl !gap-2",
        classNames: {
          toast: "!min-h-0 !py-1.5 !px-3 !text-xs !shadow-md !rounded-xl !gap-2",
          title: "!text-xs !font-semibold !leading-tight",
          description: "!text-[11px] !opacity-85 !leading-tight !mt-0.5",
          closeButton: "!size-4 !text-[10px] !p-0.5",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
