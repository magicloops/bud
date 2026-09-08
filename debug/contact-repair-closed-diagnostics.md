# Debug: Repaired scans still shown as unfinished

After a successful source repair, the server marks older unpublished scans
`superseded`. Mobile and web selected every scan whose status was not `published`,
so closed superseded scans appeared in the unfinished diagnostic list and could
crowd out genuinely pending work.

Select only `pending` and `invalid` scans for that list. Preserve superseded rows
in the API/history, and update recovery guidance to point to the explicit Repair
control when original uploads are unavailable. No publication or action state is
changed. Validate web and simulator compilation.
