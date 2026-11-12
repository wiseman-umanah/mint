import { WalletLayout } from "@/components/wallet";

export default function Layout({ children }: LayoutProps<"/wallet">) {
  return <WalletLayout>{children}</WalletLayout>;
}
