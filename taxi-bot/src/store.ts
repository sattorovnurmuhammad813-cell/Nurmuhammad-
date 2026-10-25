import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";

/**
 * Oddiy JSON-fayl ombori. MVP uchun yetarli: bot bitta jarayonda ishlaydi,
 * shuning uchun joy band qilishda poyga holati (race condition) bo'lmaydi.
 * Foydalanuvchilar ko'paysa, buni PostgreSQL yoki Redis'ga almashtirish kerak.
 */

export type Role = "passenger" | "driver";
export type DriverStatus = "pending" | "approved" | "rejected";

export interface User {
  id: number;
  name: string;
  phone?: string;
  role?: Role;
  car?: string;
  plate?: string;
  driverStatus?: DriverStatus;
  ratingSum: number;
  ratingCount: number;
}

export interface Trip {
  id: number;
  driverId: number;
  from: string;
  to: string;
  /** YYYY-MM-DD, Toshkent vaqti bo'yicha */
  date: string;
  /** HH:MM */
  time: string;
  seatsTotal: number;
  seatsFree: number;
  /** Bir joy narxi, so'mda */
  price: number;
  status: "active" | "cancelled" | "done";
}

export interface Booking {
  id: number;
  tripId: number;
  passengerId: number;
  seats: number;
  status: "active" | "cancelled";
  rated: boolean;
}

/** Ko'p bosqichli kiritish (masalan qatnov qo'shish) davomidagi holat */
export interface Session {
  step: string;
  data: Record<string, string | number>;
}

interface Db {
  nextId: number;
  users: Record<string, User>;
  trips: Trip[];
  bookings: Booking[];
  sessions: Record<string, Session>;
}

export class Store {
  private db: Db;

  constructor(private readonly file: string) {
    this.db = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Db)
      : { nextId: 1, users: {}, trips: [], bookings: [], sessions: {} };
  }

  /** Avval vaqtinchalik faylga yozib, keyin almashtiradi - yozish yarmida uzilsa fayl buzilmaydi. */
  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    renameSync(tmp, this.file);
  }

  private newId(): number {
    return this.db.nextId++;
  }

  // ---- Foydalanuvchilar ----

  getUser(id: number): User | undefined {
    return this.db.users[id];
  }

  upsertUser(id: number, patch: Partial<User> & { name: string }): User {
    const base = this.db.users[id] ?? { ratingSum: 0, ratingCount: 0 };
    const user: User = { ...base, ...patch, id };
    this.db.users[id] = user;
    this.save();
    return user;
  }

  updateUser(id: number, patch: Partial<User>): User | undefined {
    const user = this.db.users[id];
    if (!user) return undefined;
    Object.assign(user, patch);
    this.save();
    return user;
  }

  // ---- Sessiyalar ----

  getSession(chatId: number): Session | undefined {
    return this.db.sessions[chatId];
  }

  setSession(chatId: number, session: Session): void {
    this.db.sessions[chatId] = session;
    this.save();
  }

  clearSession(chatId: number): void {
    if (this.db.sessions[chatId]) {
      delete this.db.sessions[chatId];
      this.save();
    }
  }

  // ---- Qatnovlar ----

  addTrip(trip: Omit<Trip, "id" | "seatsFree" | "status">): Trip {
    const created: Trip = { ...trip, id: this.newId(), seatsFree: trip.seatsTotal, status: "active" };
    this.db.trips.push(created);
    this.save();
    return created;
  }

  getTrip(id: number): Trip | undefined {
    return this.db.trips.find((t) => t.id === id);
  }

  searchTrips(from: string, to: string, date: string, excludeDriverId: number): Trip[] {
    return this.db.trips
      .filter(
        (t) =>
          t.status === "active" &&
          t.from === from &&
          t.to === to &&
          t.date === date &&
          t.seatsFree > 0 &&
          t.driverId !== excludeDriverId,
      )
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  driverTrips(driverId: number): Trip[] {
    return this.db.trips
      .filter((t) => t.driverId === driverId && t.status === "active")
      .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  }

  /** Qatnovni yopadi va unga tegishli faol bronlarni qaytaradi (yo'lovchilarga xabar berish uchun). */
  closeTrip(id: number, status: "cancelled" | "done"): Booking[] {
    const trip = this.getTrip(id);
    if (!trip || trip.status !== "active") return [];
    trip.status = status;
    const active = this.db.bookings.filter((b) => b.tripId === id && b.status === "active");
    if (status === "cancelled") for (const b of active) b.status = "cancelled";
    this.save();
    return active;
  }

  // ---- Bronlar ----

  getBooking(id: number): Booking | undefined {
    return this.db.bookings.find((b) => b.id === id);
  }

  findActiveBooking(tripId: number, passengerId: number): Booking | undefined {
    return this.db.bookings.find(
      (b) => b.tripId === tripId && b.passengerId === passengerId && b.status === "active",
    );
  }

  tripBookings(tripId: number): Booking[] {
    return this.db.bookings.filter((b) => b.tripId === tripId && b.status === "active");
  }

  passengerBookings(passengerId: number): Booking[] {
    return this.db.bookings.filter((b) => {
      if (b.passengerId !== passengerId || b.status !== "active") return false;
      return this.getTrip(b.tripId)?.status === "active";
    });
  }

  /** Joy bo'sh bo'lsa bron yaratadi, aks holda null. */
  book(tripId: number, passengerId: number, seats: number): Booking | null {
    const trip = this.getTrip(tripId);
    if (!trip || trip.status !== "active" || trip.seatsFree < seats) return null;
    if (this.findActiveBooking(tripId, passengerId)) return null;
    trip.seatsFree -= seats;
    const booking: Booking = { id: this.newId(), tripId, passengerId, seats, status: "active", rated: false };
    this.db.bookings.push(booking);
    this.save();
    return booking;
  }

  cancelBooking(id: number): Booking | null {
    const booking = this.getBooking(id);
    if (!booking || booking.status !== "active") return null;
    booking.status = "cancelled";
    const trip = this.getTrip(booking.tripId);
    if (trip && trip.status === "active") trip.seatsFree += booking.seats;
    this.save();
    return booking;
  }

  rate(bookingId: number, stars: number): boolean {
    const booking = this.getBooking(bookingId);
    if (!booking || booking.rated) return false;
    const trip = this.getTrip(booking.tripId);
    const driver = trip && this.db.users[trip.driverId];
    if (!driver) return false;
    booking.rated = true;
    driver.ratingSum += stars;
    driver.ratingCount += 1;
    this.save();
    return true;
  }
}
