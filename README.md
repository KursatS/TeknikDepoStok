# TeknikDepo

Robot süpürge teknik servisi için yedek parça / çekmece takip uygulaması. Yerel çalışır (`http://localhost:5056`), ek paket kurulumu gerekmez.

## Çalıştırma

1. [Node.js 22 veya üzerini](https://nodejs.org) kurun (bir kez).
2. **`baslat.bat`** dosyasına çift tıklayın. Tarayıcı kendiliğinden açılır.

Kapatmak için açılan siyah pencereyi kapatın.

## Özellikler

- Dolap/çekmece düzenini kendiniz kurarsınız (satır × sütun, tek çekmece silme/ekleme)
- PN aramada ilgili çekmece parlar; kuş bakışı oda görünümünde dolap yerleşimi
- PN biçimi `00.00.0000`, minimum stok zorunlu
- Parçalar sayfasında toplam stok; çekmeceye boştaki stoktan yerleştirme
- "Parça ver": servis ID ve teknisyen kaydıyla çıkış
- Tüm hareketler kayıtlı ve geri alınabilir
- CSV içe/dışa aktarma, tek tıkla veritabanı yedeği

## Veri

Tüm veriler `depo.db` dosyasında tutulur (repoya girmez). Yedek için uygulamadaki **Yedek al** düğmesini veya bu dosyayı kopyalamayı kullanın.

Ağdaki başka cihazlardan erişmek için: `http://BILGISAYAR-IP:5056` (Windows güvenlik duvarı izin isteyebilir). Uygulamada giriş şifresi yoktur.
