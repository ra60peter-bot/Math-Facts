import { NextRequest } from "next/server";
import { changeProfileDeletion } from "../../../../lib/profile-deletion";

type Context = { params: Promise<{ id: string }> };
export async function DELETE(request: NextRequest, { params }: Context) {
  return changeProfileDeletion(request, (await params).id, "student", false);
}
export async function PATCH(request: NextRequest, { params }: Context) {
  return changeProfileDeletion(request, (await params).id, "student", true);
}
